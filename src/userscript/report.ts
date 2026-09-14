/**
 * 「草: センサーの記録」の文面 (段階 5)。持ち主が、センサーの数えた分が実感と合うかを 1 日使って確かめるためのもの。
 * メニューを押しても送信はしない (送るのは sender.ts)。DOM 注入の草 (段階 8) ができたら役目を終える。
 */
import { type Bitmap, MINUTES_PER_DAY } from "../shared/bits.ts";
import { fromEpochDay, toEpochDay } from "../shared/graph.ts";
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
}): SensorReport {
  const today = localDay(input.now);
  const day = input.store.readDay(today);

  const head = [
    `${input.title} (${input.now.toLocaleString("ja-JP")})`,
    describeStatus(input.project, input.status),
    "登録済みなら、読み込み時・日付の変更・タブを隠したときに送る",
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
      ...head,
      hidden > 0
        ? `${rangeTitle} — 新しい ${shown.length} 個。ほか ${hidden} 個はコンソール`
        : rangeTitle,
      ...(shown.length > 0 ? shown.map(formatRange) : emptyRanges),
      ...recent,
    ].join("\n"),
    console: [
      ...head,
      rangeTitle,
      ...(ranges.length > 0 ? ranges.map(formatRange) : emptyRanges),
      ...recent,
    ].join("\n"),
  };
}
