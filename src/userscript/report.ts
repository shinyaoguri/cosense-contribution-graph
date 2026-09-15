/**
 * 「草: センサーの記録」の文面 (段階 5)。持ち主が、センサーの数えた分が実感と合うかを 1 日使って確かめるためのもの。
 * 段階 6 からは送信の状況も出す。メニューを押しても送信はしない (送るのは sender.ts)。DOM 注入の草 (段階 8) ができたら役目を終える。
 */
import { type Bitmap, MINUTES_PER_DAY } from "../shared/bits.ts";
import { fromEpochDay, toEpochDay } from "../shared/graph.ts";
import { MAX_TODAY_SENDS, type SendStatus } from "./sender.ts";
import type { CountingStatus } from "./sensor.ts";
import type { Counts, Store } from "./store.ts";
import { localDay } from "./time.ts";

/** 連続した分のまとまり。`end` は含まない (0:00 からの分)。 */
export type ActivityRange = {
  readonly start: number;
  readonly end: number;
  readonly kind: "w" | "r";
};

/** alert に出す区間の数。多いとダイアログが画面からはみ出すので、残りはコンソールだけに出す。 */
export const ALERT_RANGES = 20;

const RECENT_DAYS = 7;

/**
 * 1 日のビットマップを、書き・読みの連続した区間にまとめる。
 * 同じ分に両方あれば書きに数える (design §4)。
 */
export function activityRanges(w: Bitmap, r: Bitmap): ActivityRange[] {
  const ranges: ActivityRange[] = [];
  let current: { start: number; kind: "w" | "r" } | undefined;
  for (let minute = 0; minute <= MINUTES_PER_DAY; minute++) {
    const kind =
      minute === MINUTES_PER_DAY
        ? undefined
        : hasMinute(w, minute)
          ? "w"
          : hasMinute(r, minute)
            ? "r"
            : undefined;
    if (current && current.kind !== kind) {
      ranges.push({ start: current.start, end: minute, kind: current.kind });
      current = undefined;
    }
    if (kind && !current) {
      current = { start: minute, kind };
    }
  }
  return ranges;
}

function hasMinute(bitmap: Bitmap, minute: number): boolean {
  return ((bitmap[minute >> 3] ?? 0) & (0x80 >> (minute & 7))) !== 0;
}

export function formatRange(range: ActivityRange): string {
  const label = range.kind === "w" ? "書き" : "読み";
  return `${formatMinute(range.start)}–${formatMinute(range.end)} ${label} ${range.end - range.start} 分`;
}

function formatMinute(minute: number): string {
  return `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, "0")}`;
}

function formatCounts(counts: Counts): string {
  return `書き ${counts.w} 分 / 読み ${counts.r} 分 / 編集 ${counts.pages} ページ / 新規 ${counts.created} ページ`;
}

function describeStatus(project: string, status: CountingStatus): string {
  switch (status) {
    case "counting":
      return `このタブ: ${project} を数えている`;
    case "checking":
      return `このタブ: ${project} の自分のページに import の 1 行があるか確かめている`;
    case "not-installed":
      return `このタブ: ${project} は数えていない (自分のページに import の 1 行が無い)`;
  }
}

const TRIGGER_TEXT = {
  load: "読み込み時",
  "day-change": "日付の変更",
  hidden: "タブを隠したとき",
  enrolled: "登録の直後",
} as const;

const OUTCOME_TEXT: Record<string, string> = {
  written: "書いた",
  unchanged: "変化なし (送信済みと同じ)",
  error: "★届かなかった (未登録・期限切れの鍵・形の誤り・サーバの失敗のどれか)",
  timeout: "★応答が無い",
  unexpected: "★応答の画像が想定と違う",
  "key-unusable": "★この端末の鍵で署名できない (サインインし直す)",
  storage: "★送信済みの記録を書けない",
};

/** 送信の状況。**合算の草の URL は `withUrl` のときだけ** (alert にだけ出し、コンソールに残さない) */
function describeSending(status: SendStatus, now: Date, withUrl: boolean): string[] {
  switch (status.kind) {
    case "not-enrolled":
      return [
        "送信: この端末は未登録なので送っていない。ページメニューの「草の設定」から登録すると送る",
      ];
    case "newer-key":
      return ["送信: 新しい版の cosense-grass が登録した鍵なので、この版からは送らない"];
    case "newer-sent":
      return ["送信: 新しい版の cosense-grass が送信の記録を書いているので、この版からは送らない"];
    case "storage":
      return ["送信: このブラウザの保存領域 (IndexedDB) を開けないので送っていない"];
    case "enrolled": {
      const time = (ms: number) =>
        new Date(ms).toLocaleTimeString("ja-JP", { hour: "numeric", minute: "2-digit" });
      const sameDay = (ms: number) => localDay(new Date(ms)) === localDay(now);
      const last = status.last;
      return [
        `送信: 登録済み (端末の識別子 ${status.kid})`,
        last
          ? `最後の送信: ${sameDay(last.at) ? time(last.at) : new Date(last.at).toLocaleString("ja-JP")} ${TRIGGER_TEXT[last.trigger]} — ${OUTCOME_TEXT[last.outcome] ?? last.outcome} (リクエスト ${last.requests} / エントリ ${last.entries})`
          : "最後の送信: まだ無い",
        `今日の送信: ${status.todaySends} / ${MAX_TODAY_SENDS} 回 (タブを隠したときに送る。変化が無ければ数えない)`,
        `まだ送れていない日: ${status.pendingDays} 日`,
        ...(status.backoffUntil !== undefined
          ? [`★続けて失敗したので、次に自動で送るのは ${time(status.backoffUntil)} 以降`]
          : []),
        ...(withUrl
          ? [
              `合算の草 (全プロジェクト・全端末): ${status.graphUrl}`,
              ...(status.projects.length > 0
                ? ["プロジェクト別の草 (このブラウザで直近 30 日に記録したもの):"]
                : []),
              ...status.projects.map(
                (project) =>
                  `  ${project.name}: ${project.graphUrl}${project.sent ? "" : " (まだ送っていないので表示されない)"}`,
              ),
            ]
          : []),
      ];
    }
  }
}

export type SensorReport = {
  /** ダイアログ。区間は新しい方から `ALERT_RANGES` 個まで */
  readonly alert: string;
  /** コンソール。区間をすべて出す */
  readonly console: string;
};

export function describeSensorReport(input: {
  readonly title: string;
  readonly now: Date;
  readonly project: string;
  readonly status: CountingStatus;
  readonly store: Pick<Store, "readDay">;
  readonly sending: SendStatus;
}): SensorReport {
  const today = localDay(input.now);
  const day = input.store.readDay(today);

  const head = (withUrl: boolean) => [
    `${input.title} (${input.now.toLocaleString("ja-JP")})`,
    describeStatus(input.project, input.status),
    ...describeSending(input.sending, input.now, withUrl),
    "",
    `今日 (${today})`,
    `合算: ${formatCounts(day.total.counts)}`,
    ...[...day.projects]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([project, row]) => `${project}: ${formatCounts(row.counts)}`),
    "",
  ];

  const ranges = day.total.bits ? activityRanges(day.total.bits.w, day.total.bits.r) : [];
  const shown = ranges.slice(-ALERT_RANGES);
  const hidden = ranges.length - shown.length;
  const rangeTitle = "今日の区間 (合算)";
  const emptyRanges = ["まだ無い"];

  const recent = [
    "",
    `直近 ${RECENT_DAYS} 日 (合算)`,
    ...Array.from({ length: RECENT_DAYS }, (_, i) => {
      const date = fromEpochDay(toEpochDay(today) - (RECENT_DAYS - 1 - i));
      const counts = input.store.readDay(date).total.counts;
      return `${date}: 書き ${counts.w} 分 / 読み ${counts.r} 分`;
    }),
  ];

  return {
    alert: [
      ...head(true),
      hidden > 0
        ? `${rangeTitle} — 新しい ${shown.length} 個。ほか ${hidden} 個はコンソール`
        : rangeTitle,
      ...(shown.length > 0 ? shown.map(formatRange) : emptyRanges),
      ...recent,
    ].join("\n"),
    console: [
      ...head(false),
      rangeTitle,
      ...(ranges.length > 0 ? ranges.map(formatRange) : emptyRanges),
      ...recent,
    ].join("\n"),
  };
}
