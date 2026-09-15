/**
 * 草の格子と描画パラメータ (design §8)。**草を描くのは Worker だけ** (ADR-0019)。
 *
 * 日付は `src/shared/epoch-day.ts` の通し日数で扱う。**UTC だけで計算する**ので、
 * 今日の列はサーバの日本時間で決まり、マシンのタイムゾーンに依らない。
 */
import { fromEpochDay, toEpochDay, weekdayOf } from "../../shared/epoch-day.ts";
import { DEFAULT_SCHEME, type SchemeName, type Theme } from "../../shared/scheme.ts";

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

// ラベルが重なる列の間隔。「10月」は 3 文字で約 2 列ぶんの幅がある
const MIN_LABEL_COLUMNS = 3;

/** 軸のラベル。`position` は月なら列、曜日なら行の番号 (px ではない)。 */
export type AxisLabel = {
  readonly position: number;
  readonly text: string;
};

/**
 * 月ラベル。**`toLocaleString` を使わず固定の配列から出す** (環境で表記が変わらないように)。
 *
 * 各列の最初のマスの月が前の列と変わったところに出す。
 *
 * - **前のラベルから 3 列未満なら前のラベルを捨てる。** ぶつかるのは左端の欠けた列で、その月は
 *   数日しか表示されていないので、後ろの月を優先する
 * - **右端から 3 列未満の位置には出さない。** 「10月」は約 2 列ぶんの幅があり、右端の列に置くと
 *   SVG の外へはみ出す。そこで始まる月は高々 2 週しか表示されていない
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
    if (month === previousMonth) {
      continue;
    }
    previousMonth = month;
    if (lastColumn - column < MIN_LABEL_COLUMNS - 1) {
      continue;
    }
    const last = labels.at(-1);
    if (last && column - last.position < MIN_LABEL_COLUMNS) {
      labels.pop();
    }
    labels.push({ position: column, text: MONTH_NAMES[month] ?? "" });
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
