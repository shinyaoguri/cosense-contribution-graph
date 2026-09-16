/**
 * 草の格子と描画パラメータ (design §8)。**草を描くのは Worker だけ** (ADR-0019)。
 *
 * 日付は `src/shared/epoch-day.ts` の通し日数で扱う。**UTC だけで計算する**ので、
 * 今日の列はサーバの日本時間で決まり、マシンのタイムゾーンに依らない。
 */
import { fromEpochDay, toEpochDay, weekdayOf } from "../../shared/epoch-day.ts";
import { DEFAULT_SCHEME, type SchemeName, type Theme } from "./scheme.ts";

/** 行は曜日の 7 行。日曜始まり (design §8)。 */
export const DAYS = 7;

/** 表示週数の既定と上限。 */
export const MAX_WEEKS = 53;

/** セルは 11px、間隔 3px (design §8)。 */
export const CELL = 11;
export const GAP = 3;
export const STEP = CELL + GAP;

/** `bi` は 2 次元 (色相がバランス)、`write` は全マスのバランスを 0 とみなす単色 (design §6)。 */
type Mode = "bi" | "write";

export type Params = {
  readonly theme: Theme;
  readonly weeks: number;
  readonly mode: Mode;
  /** 配色 (design §6)。四分位のスケールには効かないので、どの配色でも Level は同じ。 */
  readonly palette: SchemeName;
};

export const DEFAULT_PARAMS: Params = {
  theme: "light",
  weeks: MAX_WEEKS,
  mode: "bi",
  palette: DEFAULT_SCHEME,
};

export type GridCell = {
  readonly day: string;
  readonly column: number;
  readonly row: number;
};

/**
 * 表示するマスを並べる。
 *
 * 開始日は `today − 7 × (weeks − 1)`。**マス数は今日の曜日によらず 7 × (weeks − 1) + 1**
 * (53 週なら 365)。今日の列が右端 (column = weeks − 1) で、**今日より後と開始日より前のマスは
 * 作らない** ので、左端と右端の列が欠ける (design §8)。
 */
export function gridCells(today: string, weeks: number): GridCell[] {
  const end = toEpochDay(today);
  const start = end - DAYS * (weeks - 1);
  // 開始日を含む週の日曜が 0 列目
  const firstSunday = start - weekdayOf(start);

  const cells: GridCell[] = [];
  for (let day = start; day <= end; day++) {
    cells.push({
      day: fromEpochDay(day),
      column: Math.floor((day - firstSunday) / DAYS),
      row: weekdayOf(day),
    });
  }
  return cells;
}

const MONTH_NAMES = [
  "1月",
  "2月",
  "3月",
  "4月",
  "5月",
  "6月",
  "7月",
  "8月",
  "9月",
  "10月",
  "11月",
  "12月",
] as const;

/**
 * ラベルが要る列数。フォントは 9px で、全角の「月」が約 9px、半角の数字が約 5px。
 * 列の間隔は 14px なので「9月」(約 14px) は 1 列、「10月」(約 19px) は 2 列とみなす
 */
function labelColumns(text: string): number {
  return text.length <= 2 ? 1 : 2;
}

/** 軸のラベル。`position` は月なら列、曜日なら行の番号 (px ではない)。 */
export type AxisLabel = {
  readonly position: number;
  readonly text: string;
};

/**
 * 月ラベル。**`toLocaleString` を使わず固定の配列から出す** (環境で表記が変わらないように)。
 *
 * **その月が始まる列にだけ出す** (2026-09-16 改訂)。列の最初のマスが月の 1〜7 日なら、
 * その月はその週から始まっている。日曜始まりなので通常の列では月の最初の日曜が該当する。
 *
 * - **左端の欠けた列は、月の途中から始まっていれば出さない。** その月はもっと前に始まっていて、
 *   同じ月が右端にもう一度来ることがある (365 日は 12 か月より少し長い)。
 *   列 0 と列 1 が同じ月の候補になりうるので、前の列と同じ月なら捨てる
 * - **右端はラベルの幅ぶん空いているときだけ出す。** 右端の列に「10月」を置くと SVG の外へはみ出す
 *
 * 月ラベル同士は最短でも 4 列離れる (最も短い月で 28 日) ので、間隔は見ない。
 */
export function monthLabels(cells: readonly GridCell[]): AxisLabel[] {
  const firstDayOfColumn = new Map<number, string>();
  let lastColumn = 0;
  for (const cell of cells) {
    if (!firstDayOfColumn.has(cell.column)) {
      firstDayOfColumn.set(cell.column, cell.day);
    }
    lastColumn = Math.max(lastColumn, cell.column);
  }

  const labels: AxisLabel[] = [];
  let previousMonth = -1;
  for (const [column, day] of [...firstDayOfColumn].sort((a, b) => a[0] - b[0])) {
    const month = Number(day.slice(5, 7)) - 1;
    // 週は 7 日なので、月の 1〜7 日から始まる列がその月の最初の週
    if (Number(day.slice(8, 10)) > DAYS || month === previousMonth) {
      continue;
    }
    previousMonth = month;
    const text = MONTH_NAMES[month] ?? "";
    if (lastColumn - column + 1 < labelColumns(text)) {
      continue;
    }
    labels.push({ position: column, text });
  }
  return labels;
}

/**
 * 曜日ラベル。日曜始まりなので 0 行目が日曜 (design §8)。
 *
 * **7 行すべてに出す。** 一つ飛ばしにするのは英語の `Mon` / `Wed` / `Fri` が
 * 行の高さ (14px) に対して幅を取るからで、1 文字の日本語なら全曜日を並べても重ならない。
 */
export const WEEKDAY_LABELS: readonly AxisLabel[] = ["日", "月", "火", "水", "木", "金", "土"].map(
  (text, position) => ({ position, text }),
);
