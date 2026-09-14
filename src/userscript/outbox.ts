/**
 * 送る記録を選ぶ (design §9「送信」、段階 6)。**DOM も IndexedDB も触らない純粋な部分**で、送るのは `sender.ts`。
 *
 * - 送る日は、ローカルの今日から 29 日前まで (Worker は 30 日より古い日を含むリクエストを丸ごと 400 にする)
 * - 1 日の中身はプロジェクトごとの行と合算 `*` の行。**合算は store が各行の OR から作ったものをそのまま使う** (足さない)
 * - プロジェクト名は `phOf(uid, name)` にしてから送る。**URL にプロジェクト名を載せない**
 * - **送れた中身は、エントリごとのダイジェストで覚える** (`cosense-grass:sent`)。変わったプロジェクトと `*` だけを送り直す
 */
import { type Entry, formatEntries, MAX_ENTRIES } from "../shared/beacon.ts";
import { popcount } from "../shared/bits.ts";
import { fromEpochDay, toEpochDay } from "../shared/graph.ts";
import { sha256Hex } from "../shared/hash.ts";
import { PH_ALL, phOf } from "../shared/ids.ts";
import type { Store } from "./store.ts";

export const SENT_KEY = "cosense-grass:sent";

/** `cosense-grass:sent` の形の版。**知らない版の記録があれば送らない** (store.ts と同じ約束) */
const SENT_VERSION = 1;

/** 今日から何日前まで送るか (design §9)。時差の余裕で Worker の 30 日より 1 日短い */
const SEND_PAST_DAYS = 29;

/** URL の長さの上限。Cloudflare の上限 16KB より十分短く */
export const MAX_URL_LENGTH = 8_000;

/** `pages` と `created` の上限 (shared/beacon.ts)。これを超える数は送れないので丸める */
const MAX_COUNT = 99_999;

const DIGEST_LENGTH = 16;

export type Trigger = "load" | "day-change" | "hidden" | "enrolled";

export type SendOutcome =
  | "written"
  | "unchanged"
  | "nothing"
  | "not-enrolled"
  | "newer-key"
  | "key-unusable"
  | "limited"
  | "backoff"
  | "error"
  | "timeout"
  | "unexpected"
  | "storage"
  | "newer-sent";

type SentDay = {
  /** 送れたエントリのダイジェスト */
  readonly e: readonly string[];
  /** その日を「今日」として送り始めた回数。失敗も数える */
  readonly n: number;
};

export type SentRecord = {
  readonly v: typeof SENT_VERSION;
  readonly days: Readonly<Record<string, SentDay>>;
  /** 続けて失敗した回数と、最後に失敗した時刻 (ミリ秒) */
  readonly failure?: { readonly n: number; readonly at: number };
  readonly last?: {
    readonly at: number;
    readonly trigger: Trigger;
    readonly outcome: SendOutcome;
    readonly requests: number;
    readonly entries: number;
  };
};

export const EMPTY_SENT: SentRecord = { v: SENT_VERSION, days: {} };

/** 送る候補の日。過去日を新しい順に、`includeToday` なら先頭に今日。 */
export function candidateDays(today: string, includeToday: boolean): string[] {
  const epoch = toEpochDay(today);
  const past = Array.from({ length: SEND_PAST_DAYS }, (_, i) => fromEpochDay(epoch - 1 - i));
  return includeToday ? [today, ...past] : past;
}

/**
 * 日ごとのエントリを作る。ビットマップの無い日 (畳んだ日・知らない版の記録) と中身の無い行は捨てる。
 */
export async function collectEntries(
  store: Pick<Store, "readDay">,
  uid: string,
  days: readonly string[],
): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const day of days) {
    const view = store.readDay(day);
    const rows = [
      ...[...view.projects].map(([project, row]) => ({ project, row })),
      { project: undefined, row: view.total },
    ];
    for (const { project, row } of rows) {
      if (row.bits === undefined) {
        continue;
      }
      const pages = Math.min(row.counts.pages, MAX_COUNT);
      const created = Math.min(row.counts.created, MAX_COUNT);
      if (popcount(row.bits.w) + popcount(row.bits.r) + pages + created === 0) {
        continue;
      }
      entries.push({
        ph: project === undefined ? PH_ALL : await phOf(uid, project),
        day,
        wbits: row.bits.w,
        rbits: row.bits.r,
        pages,
        created,
      });
    }
  }
  return entries;
}

/**
 * 1 エントリのダイジェスト。**uid を混ぜる** (`*` は uid でソルトされないので、別のアカウントに入り直したら送り直す)。
 * **kid は混ぜない** (D1 の行は uid ごとなので、同じ uid で鍵を作り直しても送り直す意味が無い)。
 */
export function entryDigest(uid: string, entry: Entry): Promise<string> {
  return sha256Hex(`${uid}\n${formatEntries([entry])}`, DIGEST_LENGTH);
}

/** 送信済みの記録を読む。壊れていたら空、知らない版なら `"newer"` (送らない)。 */
export function readSent(storage: Pick<Storage, "getItem">): SentRecord | "newer" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(SENT_KEY) ?? "null");
  } catch {
    return EMPTY_SENT;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return EMPTY_SENT;
  }
  const record = parsed as Partial<SentRecord>;
  if (typeof record.v === "number" && record.v > SENT_VERSION) {
    return "newer";
  }
  if (record.v !== SENT_VERSION || typeof record.days !== "object" || record.days === null) {
    return EMPTY_SENT;
  }
  const days: Record<string, SentDay> = {};
  for (const [day, value] of Object.entries(record.days)) {
    const e = Array.isArray(value?.e)
      ? value.e.filter((d): d is string => typeof d === "string")
      : [];
    const n = Number.isInteger(value?.n) ? value.n : 0;
    days[day] = { e, n };
  }
  return { ...record, v: SENT_VERSION, days } as SentRecord;
}

/** 書く。今日から 29 日より古い日は刈る。書けなければ false */
export function writeSent(
  storage: Pick<Storage, "setItem">,
  record: SentRecord,
  today: string,
): boolean {
  const oldest = toEpochDay(today) - SEND_PAST_DAYS;
  const days = Object.fromEntries(
    Object.entries(record.days).filter(([day]) => toEpochDay(day) >= oldest),
  );
  try {
    storage.setItem(SENT_KEY, JSON.stringify({ ...record, days }));
    return true;
  } catch {
    return false;
  }
}

/**
 * 送れたダイジェストを覚える。**その日の今のダイジェストに含まれるものだけを残す**ので、
 * 中身が変わった古いダイジェストは溜まらない (その日の行の数で頭打ち)。
 */
export function rememberSent(
  record: SentRecord,
  day: string,
  sent: readonly string[],
  current: readonly string[],
): SentRecord {
  const known = new Set([...(record.days[day]?.e ?? []), ...sent]);
  const e = current.filter((digest) => known.has(digest));
  return { ...record, days: { ...record.days, [day]: { e, n: record.days[day]?.n ?? 0 } } };
}

/** 当日の送信回数を 1 増やす */
export function countTodaySend(record: SentRecord, today: string): SentRecord {
  const current = record.days[today];
  return {
    ...record,
    days: { ...record.days, [today]: { e: current?.e ?? [], n: (current?.n ?? 0) + 1 } },
  };
}

/** `MAX_ENTRIES` 件ずつに分ける (順は保つ) */
export function chunk<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += MAX_ENTRIES) {
    chunks.push(items.slice(i, i + MAX_ENTRIES));
  }
  return chunks;
}
