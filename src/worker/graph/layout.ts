/**
 * 草のレイアウト (design §8)。**寸法・色・ラベルの位置を決めるだけで、SVG の文字列も DOM も作らない。**
 *
 * 読むのは `src/worker/svg.ts` だけで、これを `<img>` で読まれる SVG の文字列にする。
 * **草を描くのは Worker だけ** (ADR-0019)。1.0.0 までは UserScript も同じレイアウトから DOM の SVG を
 * 組み立てていたので `src/shared/` に置いていた。
 *
 * **色はスキームに任せる** (`./scheme.ts`)。ここはバランスを計算してスキームに渡すだけで、
 * どの色相になるかを知らない。凡例もスキームの `legendBalances` から組み立てる。
 */

import { balanceOf, type Minutes } from "./balance.ts";
import {
  CELL,
  DAYS,
  GAP,
  type GridCell,
  gridCells,
  monthLabels,
  type Params,
  STEP,
  WEEKDAY_LABELS,
} from "./grid.ts";
import { levelOf, type Scale } from "./scale.ts";
import { type ColorScheme, schemeOf, type Theme } from "./scheme.ts";

export type GraphInput = {
  readonly today: string;
  /** 表示範囲の日ごとの分数。範囲外 (未来の日など) のキーがあっても無視する。 */
  readonly days: ReadonlyMap<string, Minutes>;
  /** `ph = '*'` の全期間から取った四分位。表示範囲とは別の母集団 (design §7)。 */
  readonly scale: Scale;
  /** 同じ母集団から取ったバランスの中心。 */
  readonly center: number;
  /**
   * 記録のある最も古い日 (計測開始とみなす。Issue #80)。
   * **これより前のマスは「計測していなかった」として塗らない** — 活動の無い日と区別する (ADR-0012)。
   * 表示範囲より前なら印は出ない (全マスが計測済みなので区別する必要が無い)
   */
  readonly startDay?: string;
  /**
   * この画像に描くプロジェクト名 (`?l=`。Issue #119)。**サーバは保存しない** —
   * 呼び出し側がクエリから読み、`isValidProjectName` を通ったものだけを渡す (ADR-0007 決定 2 の再改訂)
   */
  readonly label?: string;
  readonly params: Params;
};

type Label = {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly anchor: "start" | "end";
  /** 太字にするか。プロジェクト名だけに付ける (Issue #119) */
  readonly weight?: "bold";
};

type Swatch = { readonly x: number; readonly y: number; readonly fill: string };

export type GraphLayout = {
  readonly width: number;
  readonly height: number;
  /** マスの一辺と角の丸み */
  readonly cellSize: number;
  readonly cellRadius: number;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly textColor: string;
  /** 月 → 曜日 → 凡例の軸の順 */
  readonly labels: readonly Label[];
  /**
   * 格子のマス。日付の古い順 (`gridCells` の順)。
   * `beforeStart` のマスは**塗らず、点線の枠だけ**で描く (計測開始前。Issue #80)
   */
  readonly grid: readonly (Swatch & {
    readonly day: string;
    readonly minutes: Minutes;
    readonly beforeStart: boolean;
  })[];
  /** 計測開始前のマスの枠の色。`beforeStart` が 1 つも無ければ描かない */
  readonly mutedColor: string;
  /** 凡例のマス。2 次元なら Level の行ごとにバランスの列の順 */
  readonly legend: readonly Swatch[];
};

const PADDING = 8;
const WEEKDAY_LABEL_WIDTH = 20;
const MONTH_LABEL_HEIGHT = 14;
const LEGEND_GAP = 10;
const LEGEND_AXIS_WIDTH = 30;
const LEGEND_AXIS_HEIGHT = 12;
const LABEL_BASELINE = 9;
const FONT_SIZE = 9;
const CELL_RADIUS = 2;

// 外部フォントは読めないので OS の日本語フォントを並べる。CJK フォントの無い環境では文字化けする
const FONT_FAMILY =
  "'Hiragino Sans','Hiragino Kaku Gothic ProN','Noto Sans CJK JP','Yu Gothic',Meiryo,sans-serif";

// 背景は両テーマとも透明。埋め込み側がテーマを選ぶ前提で、文字色だけ変える
const TEXT_COLOR: Record<Theme, string> = { light: "#57606a", dark: "#9198a1" };

const LEGEND_LEVELS = [1, 2, 3, 4] as const;

/** 計測開始前のマスの枠 (design §8)。文字色より薄くして、記録のあるマスと取り違えないようにする */
const MUTED_COLOR: Record<Theme, string> = { light: "#d0d7de", dark: "#3d444d" };

/** 凡例の左に出す注記 (Issue #80)。**寸法を増やさないので、凡例の行の空きに置く** */
export const START_NOTE = "点線は計測開始前";

/**
 * プロジェクト名と注記の間 (Issue #119)。
 *
 * **名前の幅は測れないので概算する** — SVG に文字の実測幅を持ち込めない。
 * 9px の半角英数 1 文字をこの幅とみなす (太字ぶん広めに取る)。プロジェクト名は
 * 英字・数字・ハイフンだけなので全角は来ない (`isValidProjectName`)。
 * **多少ずれても困らない** — 凡例は右寄せで遠く、注記との間隔が少し空くか詰まるだけ。
 */
const BOLD_CHAR_WIDTH = 5.5;
const NOTE_GAP = 8;

// write モードは全マスのバランスを 0 とみなすので、凡例もバランス 0 の 1 列になる
const WRITE_MODE_BALANCES: readonly number[] = [0];

/** 凡例の列ごとのバランスの見本。スキームが決める。 */
function legendBalancesOf(params: Params, scheme: ColorScheme): readonly number[] {
  return params.mode === "write" ? WRITE_MODE_BALANCES : scheme.legendBalances;
}

function label(x: number, y: number, text: string, anchor: Label["anchor"] = "start"): Label {
  return { x, y, text, anchor };
}

/**
 * 凡例の行の左端に出す注記。**プロジェクト名 (太字) → 計測開始前の注記**の順に左から並べる。
 *
 * **ここに置くのは寸法を増やさないため** (Issue #80 と同じ理由)。草の高さが変わると、
 * `<img>` に寸法を固定している UserScript 側 (`graph-dialog.ts` の `GRAPH_HEIGHT`) で絵が潰れる。
 */
function bottomNotes(projectName: string | undefined, hasBeforeStart: boolean, y: number): Label[] {
  const notes: Label[] = [];
  let x = PADDING;
  if (projectName !== undefined) {
    notes.push({ x, y, text: projectName, anchor: "start", weight: "bold" });
    x += projectName.length * BOLD_CHAR_WIDTH + NOTE_GAP;
  }
  if (hasBeforeStart) {
    notes.push(label(x, y, START_NOTE));
  }
  return notes;
}

type Block = { readonly width: number; readonly height: number };

/**
 * 凡例の寸法。
 *
 * - 列が 2 本以上なら **行 = Level 1〜4、列 = バランスの見本** の 2 次元 (design §8)
 * - 列が 1 本 (write モード) なら 2 次元にしても意味が無いので **1 行 × 4 (Level 1〜4)** を横に並べる
 */
function legendBlock(balances: readonly number[]): Block {
  if (balances.length === 1) {
    // 「少ない ■■■■ 多い」
    return { width: LEGEND_AXIS_WIDTH + LEGEND_LEVELS.length * STEP - GAP + 24, height: CELL };
  }
  return {
    width: LEGEND_AXIS_WIDTH + balances.length * STEP - GAP,
    height: LEGEND_AXIS_HEIGHT + LEGEND_LEVELS.length * STEP - GAP,
  };
}

function layoutLegend(
  balances: readonly number[],
  scheme: ColorScheme,
  theme: Theme,
  x: number,
  y: number,
): { readonly swatches: Swatch[]; readonly labels: Label[] } {
  const cellsX = x + LEGEND_AXIS_WIDTH;
  // 凡例のマスは total = Infinity で渡す。合計分数で彩度を変える配色でも飽和させるため
  const swatch = (level: (typeof LEGEND_LEVELS)[number], balance: number) =>
    scheme.cell({ level, balance, total: Number.POSITIVE_INFINITY }, theme);

  if (balances.length === 1) {
    const balance = balances[0] ?? 0;
    return {
      swatches: LEGEND_LEVELS.map((level, i) => ({
        x: cellsX + i * STEP,
        y,
        fill: swatch(level, balance),
      })),
      labels: [
        label(cellsX - 4, y + LABEL_BASELINE, "少ない", "end"),
        label(cellsX + LEGEND_LEVELS.length * STEP, y + LABEL_BASELINE, "多い"),
      ],
    };
  }

  const cellsY = y + LEGEND_AXIS_HEIGHT;
  return {
    swatches: LEGEND_LEVELS.flatMap((level, row) =>
      balances.map((balance, column) => ({
        x: cellsX + column * STEP,
        y: cellsY + row * STEP,
        fill: swatch(level, balance),
      })),
    ),
    labels: [
      label(cellsX, y + LABEL_BASELINE, "読む"),
      label(cellsX + balances.length * STEP - GAP, y + LABEL_BASELINE, "書く", "end"),
      label(cellsX - 4, cellsY + LABEL_BASELINE, "少ない", "end"),
      label(cellsX - 4, cellsY + (LEGEND_LEVELS.length - 1) * STEP + LABEL_BASELINE, "多い", "end"),
    ],
  };
}

/**
 * 草のレイアウトを返す。
 *
 * **凡例は格子の下に右寄せで置く。** 右に置くと幅が増え、Cosense の本文幅で縮小される
 * (53 週で 870px 対 775px)。全体の幅は格子と凡例の大きい方 (`weeks` が小さいと凡例が広い)。
 */
export function layoutGraph(input: GraphInput): GraphLayout {
  const { params } = input;
  const scheme = schemeOf(params.palette);
  const cells = gridCells(input.today, params.weeks);
  const legendBalances = legendBalancesOf(params, scheme);

  const gridWidth = params.weeks * STEP - GAP;
  const gridHeight = DAYS * STEP - GAP;
  const legend = legendBlock(legendBalances);
  const contentWidth = Math.max(WEEKDAY_LABEL_WIDTH + gridWidth, legend.width);

  const gridX = PADDING + WEEKDAY_LABEL_WIDTH;
  const gridY = PADDING + MONTH_LABEL_HEIGHT;

  const grid = cells.map((cell: GridCell) => {
    const minutes = input.days.get(cell.day) ?? { w: 0, r: 0 };
    const beforeStart = input.startDay !== undefined && cell.day < input.startDay;
    const total = minutes.w + minutes.r;
    const level = levelOf(total, input.scale);
    // write モードは全マスのバランスを 0 とみなす。スキームごとの特別扱いを要らなくするため
    const balance = params.mode === "write" ? 0 : balanceOf(minutes, input.center);
    return {
      x: gridX + cell.column * STEP,
      y: gridY + cell.row * STEP,
      fill: scheme.cell({ level, balance, total }, params.theme),
      day: cell.day,
      minutes,
      beforeStart,
    };
  });
  const hasBeforeStart = grid.some((cell) => cell.beforeStart);

  const legendX = PADDING + contentWidth - legend.width;
  const legendY = gridY + gridHeight + LEGEND_GAP;
  const legendParts = layoutLegend(legendBalances, scheme, params.theme, legendX, legendY);

  return {
    // width / height / viewBox の 3 つを必ず出す。欠けると Cosense でサイズが崩れる (design §8)
    width: PADDING * 2 + contentWidth,
    height: PADDING + MONTH_LABEL_HEIGHT + gridHeight + LEGEND_GAP + legend.height + PADDING,
    cellSize: CELL,
    cellRadius: CELL_RADIUS,
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    textColor: TEXT_COLOR[params.theme],
    mutedColor: MUTED_COLOR[params.theme],
    labels: [
      ...bottomNotes(input.label, hasBeforeStart, legendY + LABEL_BASELINE),
      ...monthLabels(cells).map((month) =>
        label(gridX + month.position * STEP, PADDING + LABEL_BASELINE, month.text),
      ),
      ...WEEKDAY_LABELS.map((weekday) =>
        label(gridX - 4, gridY + weekday.position * STEP + LABEL_BASELINE, weekday.text, "end"),
      ),
      ...legendParts.labels,
    ],
    grid,
    legend: legendParts.swatches,
  };
}
