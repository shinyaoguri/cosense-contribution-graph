/**
 * センサーの記録を localStorage に置く (design §9、段階 5)。読むのは送信 (段階 6) だけ。
 *
 * | キー | 中身 | 持つ日数 |
 * |---|---|---|
 * | `cosense-grass:bits` | 日 → プロジェクト名 → 書き・読みのビットマップ、編集したページ・新規作成したページの ID | 今日と前の 29 日 |
 *
 * **持つのは送れる範囲だけ** (ADR-0019)。草を描くのは Worker なので、送った後の記録をここに残す理由が無い。
 * 1.0.0 までは 371 日ぶんの集計値 (`cosense-grass:daily`) も持っていた。`sweep` がそれを消す。
 *
 * - **キーはプロジェクト名。** ph は uid でソルトするが、サインイン前は uid が無く、別のアカウントで
 *   サインインし直せば変わる。ph は送る直前に導く。プロジェクト名はこのブラウザにだけ置く値なので、
 *   キーにしても外へ出る情報は増えない
 * - **合算 `*` はビットマップに持たない。** 読むときに各行の OR で作る。別に書くと食い違いうる。
 *   同じ分に 2 つのプロジェクトで活動しても 1 分に数える (design §5 と同じ理由)
 * - **書くたびに読み直す。** localStorage はオリジン単位で、別のプロジェクトのタブとも共有される。
 *   読む → OR → 書くを同期の 1 区間で済ませ、別のタブが間に書いた bit を消さない
 */
import { decodeBase64url, encodeBase64url } from "../shared/base64url.ts";
import {
  andNotBits,
  BITMAP_BYTES,
  type Bitmap,
  bitmapOf,
  bitsEqual,
  isBitmap,
  orBits,
  popcount,
} from "../shared/bits.ts";
import { fromEpochDay, toEpochDay } from "../shared/graph.ts";
import { PH_ALL } from "../shared/ids.ts";

export const BITS_KEY = "cosense-grass:bits";

/**
 * 1.0.0 までが日次集計を置いていたキー。**もう書かない** (ADR-0019)。
 * 残っているブラウザから消すために名前だけ残す (`sweep` と `cleaner.ts` が使う)。
 */
export const LEGACY_DAILY_KEY = "cosense-grass:daily";

/** 記録の形の版。**知らない版の記録があれば書かない** (新しい版のバンドルが別のタブで書いた形を壊さない)。 */
export const STORE_VERSION = 1;

/**
 * ビットマップを持つ日数。今日と、その前の 29 日。
 * **ローカルの今日から 29 日より古い日は送らない** (design §9) ので、それより古いビットマップは使い道が無い。
 */
export const BITS_DAYS = 30;

export type StoreStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** 1 日の集計値 (design §4)。`r` は書きと重なる分を除いた読み。 */
type Counts = {
  readonly w: number;
  readonly r: number;
  readonly pages: number;
  readonly created: number;
};

/** センサーが記録する 1 回分。分はローカル時刻の 0:00 からの分。 */
export type Activity =
  | {
      readonly kind: "read";
      readonly project: string;
      readonly day: string;
      readonly minute: number;
    }
  | {
      readonly kind: "write";
      readonly project: string;
      readonly day: string;
      readonly minute: number;
      /** 編集したページ。レイアウトが page でなければ無い */
      readonly pageId?: string;
    }
  | {
      readonly kind: "created";
      readonly project: string;
      readonly day: string;
      readonly pageId: string;
    };

type WriteOutcome =
  | "written"
  /** 既に入っていたので書かなかった */
  | "unchanged"
  /** 知らない版の記録があるので書かなかった */
  | "blocked"
  /** 書き込みが例外になった (容量超過など) */
  | "failed";

type RowView = {
  readonly counts: Counts;
  /** ビットマップを持つ日 (直近 30 日) だけ。畳んだ日は集計値しか無い */
  readonly bits?: { readonly w: Bitmap; readonly r: Bitmap };
};

type DayView = {
  /** 合算 (`*`) */
  readonly total: RowView;
  readonly projects: ReadonlyMap<string, RowView>;
};

export type Store = {
  /** 活動を 1 つ記録する。**分の bit やページ ID が既に入っていれば書かない** (書き込みは分に 1 回まで)。 */
  record(activity: Activity): WriteOutcome;
  /**
   * 古い記録を掃除する。**ビットマップは 30 日ぶんだけ残す** (それより古い日は送れない)。
   * あわせて 1.0.0 までの日次集計を消す (ADR-0019)。
   */
  sweep(today: string): WriteOutcome;
  readDay(day: string): DayView;
};

const ZERO: Counts = { w: 0, r: 0, pages: 0, created: 0 };

const EMPTY_DAY: DayView = { total: { counts: ZERO }, projects: new Map() };

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Cosense のページ ID は 24 桁の 16 進数。形が変わっても壊れないよう、長さの上限だけを見る。 */
const MAX_PAGE_ID_LENGTH = 64;

type Row = {
  w: Bitmap;
  r: Bitmap;
  pages: Set<string>;
  created: Set<string>;
};

type Loaded<T> =
  | { readonly kind: "ok"; readonly days: Map<string, Map<string, T>> }
  | { readonly kind: "unknown" };

export function createStore(storage: StoreStorage, warn: (message: string) => void): Store {
  // 同じ警告を 20 秒ごとに出さない
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (!warned.has(key)) {
      warned.add(key);
      warn(message);
    }
  };

  function load<T>(key: string, readRow: (value: unknown) => T | undefined): Loaded<T> {
    const raw = storage.getItem(key);
    if (raw === null) {
      return { kind: "ok", days: new Map() };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warnOnce(`corrupt:${key}`, `${key} が JSON として読めないので、空から書き直す`);
      return { kind: "ok", days: new Map() };
    }
    if (!isObject(parsed) || typeof parsed.v !== "number" || !isObject(parsed.days)) {
      warnOnce(`corrupt:${key}`, `${key} の形が違うので、空から書き直す`);
      return { kind: "ok", days: new Map() };
    }
    if (parsed.v !== STORE_VERSION) {
      warnOnce(
        `version:${key}`,
        `${key} は版 ${parsed.v} の記録なので、この版 (${STORE_VERSION}) は書かない`,
      );
      return { kind: "unknown" };
    }

    const days = new Map<string, Map<string, T>>();
    for (const [day, projects] of Object.entries(parsed.days)) {
      if (!isValidDay(day) || !isObject(projects)) {
        continue;
      }
      const rows = new Map<string, T>();
      for (const [project, value] of Object.entries(projects)) {
        const row = project === "" ? undefined : readRow(value);
        if (row !== undefined) {
          rows.set(project, row);
        }
      }
      days.set(day, rows);
    }
    return { kind: "ok", days };
  }

  function save<T>(
    key: string,
    days: Map<string, Map<string, T>>,
    writeRow: (row: T) => unknown,
  ): WriteOutcome {
    const json = JSON.stringify({
      v: STORE_VERSION,
      days: Object.fromEntries(
        [...days].map(([day, rows]) => [
          day,
          Object.fromEntries([...rows].map(([project, row]) => [project, writeRow(row)])),
        ]),
      ),
    });
    try {
      storage.setItem(key, json);
      return "written";
    } catch (error) {
      warnOnce(`failed:${key}`, `${key} を localStorage に書けなかった: ${String(error)}`);
      return "failed";
    }
  }

  const loadBits = () => load(BITS_KEY, readBitsRow);
  const saveBits = (days: Map<string, Map<string, Row>>) => save(BITS_KEY, days, writeBitsRow);
  /**
   * 1.0.0 までの日次集計を消す (ADR-0019)。**版で門番する** — 知らない版が書いたものは触らない
   * (`load` と同じ約束)。消せたときだけ true。
   */
  function removeLegacyDaily(): boolean {
    const raw = storage.getItem(LEGACY_DAILY_KEY);
    if (raw === null) {
      return false;
    }
    let version: unknown;
    try {
      const parsed: unknown = JSON.parse(raw);
      version = isObject(parsed) ? parsed.v : undefined;
    } catch {
      // 自分たちの書いた形になっていないので、版を問わず捨てる
      version = undefined;
    }
    if (typeof version === "number" && version > STORE_VERSION) {
      return false;
    }
    try {
      storage.removeItem(LEGACY_DAILY_KEY);
      return true;
    } catch (error) {
      warnOnce(
        `failed:${LEGACY_DAILY_KEY}`,
        `${LEGACY_DAILY_KEY} を localStorage から消せなかった: ${String(error)}`,
      );
      return false;
    }
  }

  return {
    record(activity) {
      assertActivity(activity);
      const bits = loadBits();
      if (bits.kind === "unknown") {
        return "blocked";
      }
      let rows = bits.days.get(activity.day);
      if (!rows) {
        rows = new Map();
        bits.days.set(activity.day, rows);
      }
      let row = rows.get(activity.project);
      if (!row) {
        row = emptyRow();
        rows.set(activity.project, row);
      }
      if (!applyActivity(row, activity)) {
        return "unchanged";
      }
      return saveBits(bits.days);
    },

    sweep(today) {
      assertDay(today);
      const bitsFrom = toEpochDay(today) - (BITS_DAYS - 1);
      const bits = loadBits();
      if (bits.kind === "unknown") {
        return "blocked";
      }
      // **レガシーの掃除でビットマップの掃除を止めない。** 消せなくても続ける
      const removedLegacy = removeLegacyDaily();
      const oldDays = [...bits.days.keys()].filter((day) => toEpochDay(day) < bitsFrom);
      if (oldDays.length === 0) {
        return removedLegacy ? "written" : "unchanged";
      }
      for (const day of oldDays) {
        bits.days.delete(day);
      }
      return saveBits(bits.days);
    },

    readDay(day) {
      assertDay(day);
      const bits = loadBits();
      const rows = bits.kind === "ok" ? bits.days.get(day) : undefined;
      return rows && rows.size > 0 ? viewRows(rows) : EMPTY_DAY;
    },
  };
}

function emptyRow(): Row {
  return {
    w: new Uint8Array(BITMAP_BYTES),
    r: new Uint8Array(BITMAP_BYTES),
    pages: new Set(),
    created: new Set(),
  };
}

/** 行を書き換え、変わったかを返す。 */
function applyActivity(row: Row, activity: Activity): boolean {
  switch (activity.kind) {
    case "read":
      return setMinute(row, "r", activity.minute);
    case "write": {
      const minuteChanged = setMinute(row, "w", activity.minute);
      const pageChanged = activity.pageId !== undefined && addId(row.pages, activity.pageId);
      return minuteChanged || pageChanged;
    }
    case "created":
      return addId(row.created, activity.pageId);
  }
}

function setMinute(row: Row, kind: "w" | "r", minute: number): boolean {
  const next = orBits(row[kind], bitmapOf([minute]));
  if (bitsEqual(next, row[kind])) {
    return false;
  }
  row[kind] = next;
  return true;
}

function addId(ids: Set<string>, id: string): boolean {
  if (ids.has(id)) {
    return false;
  }
  ids.add(id);
  return true;
}

function countsOf(w: Bitmap, r: Bitmap, pages: number, created: number): Counts {
  // 同じ分に両方あれば書きに数える (design §4)
  return { w: popcount(w), r: popcount(andNotBits(r, w)), pages, created };
}

/** 1 日の行から、プロジェクト別と合算の見え方を作る。 */
function viewRows(rows: ReadonlyMap<string, Row>): DayView {
  let w: Bitmap = new Uint8Array(BITMAP_BYTES);
  let r: Bitmap = new Uint8Array(BITMAP_BYTES);
  const pages = new Set<string>();
  const created = new Set<string>();
  const projects = new Map<string, RowView>();
  for (const [project, row] of rows) {
    projects.set(project, {
      counts: countsOf(row.w, row.r, row.pages.size, row.created.size),
      bits: { w: row.w, r: row.r },
    });
    // **合算は OR と和集合。** 行の和にすると、2 つのプロジェクトで同じ分に活動したときに 2 分に数える
    w = orBits(w, row.w);
    r = orBits(r, row.r);
    for (const id of row.pages) {
      pages.add(id);
    }
    for (const id of row.created) {
      created.add(id);
    }
  }
  return {
    total: { counts: countsOf(w, r, pages.size, created.size), bits: { w, r } },
    projects,
  };
}

function readBitsRow(value: unknown): Row | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  return {
    // 壊れたビットマップは 0 として読み、次の書き込みで直す
    w: readBitmap(value.w),
    r: readBitmap(value.r),
    pages: readIds(value.pages),
    created: readIds(value.created),
  };
}

function writeBitsRow(row: Row): unknown {
  return {
    w: encodeBase64url(row.w),
    r: encodeBase64url(row.r),
    pages: [...row.pages],
    created: [...row.created],
  };
}

function readBitmap(value: unknown): Bitmap {
  const bytes = typeof value === "string" ? decodeBase64url(value) : undefined;
  return bytes && isBitmap(bytes) ? bytes : new Uint8Array(BITMAP_BYTES);
}

function readIds(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter(isValidPageId) : []);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDay(day: string): boolean {
  // 2026-02-30 のような実在しない日を弾く (Date.UTC は繰り上げて受け付ける)
  return DAY_PATTERN.test(day) && fromEpochDay(toEpochDay(day)) === day;
}

function isValidPageId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PAGE_ID_LENGTH;
}

function assertDay(day: string): void {
  if (!isValidDay(day)) {
    throw new RangeError(`日付は実在する YYYY-MM-DD で渡す: ${day}`);
  }
}

function assertActivity(activity: Activity): void {
  assertDay(activity.day);
  // `*` は合算の予約値 (design §3)。Cosense のプロジェクト名には使えない文字
  if (activity.project === "" || activity.project === PH_ALL) {
    throw new RangeError(`プロジェクト名が不正: ${activity.project}`);
  }
  if ("pageId" in activity && activity.pageId !== undefined && !isValidPageId(activity.pageId)) {
    throw new RangeError(`ページ ID が不正: ${activity.pageId}`);
  }
}
