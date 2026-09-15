/**
 * センサーの記録を、登録した鍵で署名して `/v1/p.gif` に送る (design §9「送信」、段階 6)。
 *
 * **定期送信はしない** (ADR-0010)。きっかけは次の 4 つ。
 *
 * | きっかけ | 送るもの |
 * |---|---|
 * | 読み込み時 | 前日以前の未送信の日 |
 * | 日付の変更 | 前日以前の未送信の日 (前日を含む) |
 * | タブを隠したとき | 前日以前の未送信の日と、今日 (当日の送信が 4 回未満のとき) |
 * | 登録の成功 | 前日以前の未送信の日と、今日 |
 *
 * - **1 回の実行はロックの中で直列にする** (Web Locks。別のタブ・別の版のバンドルと重ならない)。
 *   待った側は送信済みの記録を読み直すので、同じ中身を 2 回送らない。OR なので重なっても無害
 * - **鍵はきっかけのたびに読み直す** (別のタブで登録した鍵を拾う)。未登録なら送らない
 * - 16 (変化なし) と 17 (書いた) はどちらも送信済み。**画像にならない・応答が無い・幅が想定外なら、そこで打ち切って送信済みにしない**
 * - 続けて失敗したら、自動のきっかけでは `min(15 分 × 2^(n−1), 24 時間)` 送らない (同じ 400 を送り続けない)。登録の成功で解除
 * - **uid・ph・kid・URL・プロジェクト名・例外のメッセージはログに出さない**
 */
import { buildIngestUrl, readIngestWidth } from "../shared/beacon.ts";
import { PH_ALL, phOf, publicIdOf } from "../shared/ids.ts";
import { sign } from "../shared/sign.ts";
import type { ImageResult } from "./image.ts";
import type { DeviceStore } from "./keys.ts";
import {
  candidateDays,
  chunk,
  collectEntries,
  countTodaySend,
  entryDigest,
  MAX_URL_LENGTH,
  readSent,
  rememberSent,
  type SendOutcome,
  type SentRecord,
  type Trigger,
  writeSent,
} from "./outbox.ts";
import { MENU_TITLE, SETTINGS_LABEL } from "./settings.ts";
import type { Store } from "./store.ts";
import { localDay } from "./time.ts";
import { graphUrl, WORKER_ORIGIN } from "./worker-origin.ts";

/** 当日分を送る回数の上限 (design §9・§15 の仮値)。失敗も数える */
export const MAX_TODAY_SENDS = 4;

const BACKOFF_BASE_MS = 15 * 60_000;
const BACKOFF_MAX_MS = 24 * 60 * 60_000;

export type SenderDependencies = {
  readonly store: Pick<Store, "readDay">;
  readonly keys: Pick<DeviceStore, "read">;
  readonly sendImage: (url: string) => Promise<ImageResult>;
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly now: () => Date;
  /** 別のタブと重ならないように直列にする。本番は Web Locks、無ければそのまま走らせる */
  readonly withLock: <T>(run: () => Promise<T>) => Promise<T>;
  /** 結果の種類だけを出す */
  readonly warn: (message: string) => void;
};

/** 「草: センサーの記録」に出す送信の状況 */
export type SendStatus =
  | { readonly kind: "not-enrolled" | "newer-key" | "newer-sent" | "storage" }
  | {
      readonly kind: "enrolled";
      readonly kid: string;
      /** 合算の草。**ダイアログにだけ出す** (コンソールにもログにも残さない) */
      readonly graphUrl: string;
      /**
       * 合算の行 (`*`) を 1 件でも送れたか。false なら共有 SVG はまだ無いので 404 になる (Issue #100)。
       * ほかの端末から送っていれば草はあるので、**読むかどうかは見る側が決める**
       */
      readonly totalSent: boolean;
      /**
       * このブラウザで直近 30 日に記録したプロジェクトの草 (名前の順)。`sent` が false なら、まだ 1 件も送れていないので URL は 404 になる。
       * **ダイアログにだけ出す**
       */
      readonly projects: readonly {
        readonly name: string;
        readonly graphUrl: string;
        readonly sent: boolean;
      }[];
      readonly todaySends: number;
      /** まだ送れていないエントリのある日 (今日を含む) */
      readonly pendingDays: number;
      readonly last?: SentRecord["last"];
      /** 抑制中なら、次に自動で送る時刻 (ミリ秒) */
      readonly backoffUntil?: number;
    };

export type Sender = {
  trigger(kind: Trigger): Promise<SendOutcome>;
  status(): Promise<SendStatus>;
};

/** 続けて n 回失敗した後、自動では送らない時間 */
export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(failures - 1, 0), BACKOFF_MAX_MS);
}

export function createSender(deps: SenderDependencies): Sender {
  const warned = new Set<SendOutcome>();

  return {
    async trigger(kind) {
      let outcome: SendOutcome;
      try {
        outcome = await deps.withLock(() => send(kind, deps));
      } catch {
        outcome = "error";
      }
      // 送れない状態は読み込みごとに 1 回だけ知らせる
      if (
        (outcome === "not-enrolled" || outcome === "key-unusable" || outcome === "newer-key") &&
        !warned.has(outcome)
      ) {
        warned.add(outcome);
        deps.warn(
          outcome === "not-enrolled"
            ? `この端末は未登録なので記録を送っていません。ページメニューの「${MENU_TITLE}」→「${SETTINGS_LABEL}」から登録してください`
            : outcome === "newer-key"
              ? "新しい版の cosense-grass が登録した鍵なので、この版からは送りません"
              : "この端末の鍵で署名できないので記録を送っていません。サインインし直してください",
        );
      }
      return outcome;
    },

    async status() {
      const now = deps.now();
      const today = localDay(now);
      const sent = readSent(deps.storage);
      if (sent === "newer") {
        return { kind: "newer-sent" };
      }
      let device: Awaited<ReturnType<DeviceStore["read"]>>;
      try {
        device = await deps.keys.read();
      } catch {
        return { kind: "storage" };
      }
      if (device.kind === "newer") {
        return { kind: "newer-key" };
      }
      if (device.kind !== "found") {
        return { kind: "not-enrolled" };
      }
      const { uid, kid } = device.record;
      const days = candidateDays(today, true);
      const entries = await collectEntries(deps.store, uid, days);
      const pendingDays = new Set<string>();
      const sentPhs = new Set<string>();
      for (const entry of entries) {
        if ((sent.days[entry.day]?.e ?? []).includes(await entryDigest(uid, entry))) {
          sentPhs.add(entry.ph);
        } else {
          pendingDays.add(entry.day);
        }
      }
      // プロジェクト名はこのブラウザにだけある。publicId は uid からしか導けないので、ここで作って見せる
      const names = new Set(days.flatMap((day) => [...deps.store.readDay(day).projects.keys()]));
      const projects = await Promise.all(
        [...names]
          .sort((a, b) => a.localeCompare(b))
          .map(async (name) => {
            const ph = await phOf(uid, name);
            return { name, graphUrl: graphUrl(await publicIdOf(uid, ph)), sent: sentPhs.has(ph) };
          }),
      );
      const backoffUntil = sent.failure ? sent.failure.at + backoffMs(sent.failure.n) : undefined;
      return {
        kind: "enrolled",
        kid,
        graphUrl: graphUrl(await publicIdOf(uid, PH_ALL)),
        totalSent: sentPhs.has(PH_ALL),
        projects,
        todaySends: sent.days[today]?.n ?? 0,
        pendingDays: pendingDays.size,
        ...(sent.last ? { last: sent.last } : {}),
        ...(backoffUntil !== undefined && backoffUntil > now.getTime() ? { backoffUntil } : {}),
      };
    },
  };
}

async function send(kind: Trigger, deps: SenderDependencies): Promise<SendOutcome> {
  const startedAt = deps.now();
  const today = localDay(startedAt);
  const read = readSent(deps.storage);
  if (read === "newer") {
    return "newer-sent";
  }
  let sent: SentRecord = read;

  if (
    kind !== "enrolled" &&
    sent.failure &&
    startedAt.getTime() - sent.failure.at < backoffMs(sent.failure.n)
  ) {
    return "backoff";
  }

  let device: Awaited<ReturnType<DeviceStore["read"]>>;
  try {
    device = await deps.keys.read();
  } catch {
    return "storage";
  }
  if (device.kind === "newer") {
    return "newer-key";
  }
  if (device.kind !== "found") {
    return "not-enrolled";
  }
  const { uid, kid, privateKey } = device.record;

  const entries = await collectEntries(
    deps.store,
    uid,
    candidateDays(today, kind === "hidden" || kind === "enrolled"),
  );
  const digests = await Promise.all(entries.map((entry) => entryDigest(uid, entry)));
  const currentByDay = new Map<string, string[]>();
  for (const [i, entry] of entries.entries()) {
    currentByDay.set(entry.day, [...(currentByDay.get(entry.day) ?? []), digests[i] ?? ""]);
  }
  let pending = entries
    .map((entry, i) => ({ entry, digest: digests[i] ?? "" }))
    .filter(({ entry, digest }) => !(sent.days[entry.day]?.e ?? []).includes(digest));

  // **当日分は 1 日 4 回まで** (書き込み予算。design §11)。過去日は数えない
  const todayPending = pending.some(({ entry }) => entry.day === today);
  if (todayPending && (sent.days[today]?.n ?? 0) >= MAX_TODAY_SENDS) {
    pending = pending.filter(({ entry }) => entry.day !== today);
    if (pending.length === 0) {
      return "limited";
    }
  }
  if (pending.length === 0) {
    return "nothing";
  }
  // 送る前に数える。失敗しても数えるので、リクエストの数に上限がかかる
  if (pending.some(({ entry }) => entry.day === today)) {
    sent = countTodaySend(sent, today);
    if (!writeSent(deps.storage, sent, today)) {
      return "storage";
    }
  }

  let outcome: SendOutcome = "unchanged";
  let requests = 0;
  for (const batch of chunk(pending)) {
    let url: string;
    try {
      url = await buildIngestUrl(
        WORKER_ORIGIN,
        {
          uid,
          kid,
          time: Math.floor(deps.now().getTime() / 1000),
          entries: batch.map(({ entry }) => entry),
        },
        (input) => sign(privateKey, input),
      );
    } catch {
      // 署名できない (Firefox で鍵を読み戻せない報告がある) か、送る形の誤り。**例外のメッセージには ph が入りうる**
      outcome = "key-unusable";
      break;
    }
    if (url.length > MAX_URL_LENGTH) {
      outcome = "unexpected";
      break;
    }
    requests++;
    const result = await deps.sendImage(url);
    const width = result.kind === "loaded" ? readIngestWidth(result.width) : undefined;
    if (width === undefined) {
      outcome =
        result.kind === "timeout" ? "timeout" : result.kind === "error" ? "error" : "unexpected";
      break;
    }
    if (width.written) {
      outcome = "written";
    }
    for (const day of new Set(batch.map(({ entry }) => entry.day))) {
      const sentDigests = batch
        .filter(({ entry }) => entry.day === day)
        .map(({ digest }) => digest);
      sent = rememberSent(sent, day, sentDigests, currentByDay.get(day) ?? []);
    }
    writeSent(deps.storage, sent, today);
  }

  const failed = outcome !== "written" && outcome !== "unchanged";
  const { failure: _previous, ...rest } = sent;
  sent = {
    ...rest,
    ...(failed ? { failure: { n: (sent.failure?.n ?? 0) + 1, at: deps.now().getTime() } } : {}),
    last: { at: deps.now().getTime(), trigger: kind, outcome, requests, entries: pending.length },
  };
  writeSent(deps.storage, sent, today);
  return outcome;
}
