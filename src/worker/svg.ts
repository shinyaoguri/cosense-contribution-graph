/**
 * 草の SVG を組み立てる (design §8)。
 *
 * `<img>` 経由で描画されるので完全に非インタラクティブで、外部フォントも外部 CSS も読めない。
 * すべてインラインで自己完結させる。
 *
 * **色はスキームに任せる** (`src/shared/scheme.ts`)。ここはバランスを計算してスキームに渡すだけで、
 * どの色相になるかを知らない。凡例もスキームの `legendBalances` から組み立てる。
 */
import { balanceOf, type Minutes } from "../shared/balance.ts";
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
} from "../shared/graph.ts";
import { levelOf, type Scale } from "../shared/scale.ts";
import { type ColorScheme, schemeOf, type Theme } from "../shared/scheme.ts";

/** 疎通確認と見た目の確認のために予約した publicId。 */
export const DEMO_PUBLIC_ID = "demo";

export type GraphInput = {
  readonly today: string;
  /** 表示範囲の日ごとの分数。範囲外 (未来の日など) のキーがあっても無視する。 */
  readonly days: ReadonlyMap<string, Minutes>;
  /** `ph = '*'` の全期間から取った四分位。表示範囲とは別の母集団 (design §7)。 */
  readonly scale: Scale;
  /** 同じ母集団から取ったバランスの中心。 */
  readonly center: number;
  readonly params: Params;
};

const PADDING = 8;
const WEEKDAY_LABEL_WIDTH = 20;
const MONTH_LABEL_HEIGHT = 14;
const LEGEND_GAP = 10;
const LEGEND_AXIS_WIDTH = 30;
const LEGEND_AXIS_HEIGHT = 12;
const LABEL_BASELINE = 9;
const FONT_SIZE = 9;

// 外部フォントは読めないので OS の日本語フォントを並べる。CJK フォントの無い環境では文字化けする
const FONT_FAMILY =
  "'Hiragino Sans','Hiragino Kaku Gothic ProN','Noto Sans CJK JP','Yu Gothic',Meiryo,sans-serif";

// 背景は両テーマとも透明。埋め込み側がテーマを選ぶ前提で、文字色だけ変える
const TEXT_COLOR: Record<Theme, string> = { light: "#57606a", dark: "#9198a1" };

const LEGEND_LEVELS = [1, 2, 3, 4] as const;

// write モードは全マスのバランスを 0 とみなすので、凡例もバランス 0 の 1 列になる
const WRITE_MODE_BALANCES: readonly number[] = [0];

/** 凡例の列ごとのバランスの見本。スキームが決める。 */
function legendBalancesOf(params: Params, scheme: ColorScheme): readonly number[] {
  return params.mode === "write" ? WRITE_MODE_BALANCES : scheme.legendBalances;
}

/** SVG に出す文字列をエスケープする。今出すのは固定のラベルだけだが、原則として全部通す (design §6)。 */
function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function rect(x: number, y: number, fill: string): string {
  return `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}"/>`;
}

function text(x: number, y: number, content: string, anchor: "start" | "end" = "start"): string {
  const anchorAttr = anchor === "end" ? ' text-anchor="end"' : "";
  return `<text x="${x}" y="${y}"${anchorAttr}>${escapeXml(content)}</text>`;
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

function renderLegend(
  balances: readonly number[],
  scheme: ColorScheme,
  theme: Theme,
  x: number,
  y: number,
): { readonly cells: string; readonly labels: string } {
  const cellsX = x + LEGEND_AXIS_WIDTH;
  // 凡例のマスは total = Infinity で渡す。合計分数で彩度を変える配色でも飽和させるため
  const swatch = (level: (typeof LEGEND_LEVELS)[number], balance: number) =>
    scheme.cell({ level, balance, total: Number.POSITIVE_INFINITY }, theme);

  if (balances.length === 1) {
    const balance = balances[0] ?? 0;
    const cells = LEGEND_LEVELS.map((level, i) =>
      rect(cellsX + i * STEP, y, swatch(level, balance)),
    ).join("");
    const labels =
      text(cellsX - 4, y + LABEL_BASELINE, "少ない", "end") +
      text(cellsX + LEGEND_LEVELS.length * STEP, y + LABEL_BASELINE, "多い");
    return { cells, labels };
  }

  const cellsY = y + LEGEND_AXIS_HEIGHT;
  const cells = LEGEND_LEVELS.flatMap((level, row) =>
    balances.map((balance, column) =>
      rect(cellsX + column * STEP, cellsY + row * STEP, swatch(level, balance)),
    ),
  ).join("");
  const labels =
    text(cellsX, y + LABEL_BASELINE, "読む") +
    text(cellsX + balances.length * STEP - GAP, y + LABEL_BASELINE, "書く", "end") +
    text(cellsX - 4, cellsY + LABEL_BASELINE, "少ない", "end") +
    text(cellsX - 4, cellsY + (LEGEND_LEVELS.length - 1) * STEP + LABEL_BASELINE, "多い", "end");
  return { cells, labels };
}

/**
 * 草の SVG を返す。
 *
 * **凡例は格子の下に右寄せで置く。** 右に置くと幅が増え、Cosense の本文幅で縮小される
 * (53 週で 870px 対 775px)。全体の幅は格子と凡例の大きい方 (`weeks` が小さいと凡例が広い)。
 */
export function renderGraph(input: GraphInput): string {
  const { params } = input;
  const scheme = schemeOf(params.palette);
  const cells = gridCells(input.today, params.weeks);
  const legendBalances = legendBalancesOf(params, scheme);

  const gridWidth = params.weeks * STEP - GAP;
  const gridHeight = DAYS * STEP - GAP;
  const legend = legendBlock(legendBalances);
  const contentWidth = Math.max(WEEKDAY_LABEL_WIDTH + gridWidth, legend.width);

  // width / height / viewBox の 3 つを必ず出す。欠けると Cosense でサイズが崩れる (design §8)
  const width = PADDING * 2 + contentWidth;
  const height = PADDING + MONTH_LABEL_HEIGHT + gridHeight + LEGEND_GAP + legend.height + PADDING;

  const gridX = PADDING + WEEKDAY_LABEL_WIDTH;
  const gridY = PADDING + MONTH_LABEL_HEIGHT;

  const gridRects = cells
    .map((cell: GridCell) => {
      const minutes = input.days.get(cell.day) ?? { w: 0, r: 0 };
      const total = minutes.w + minutes.r;
      const level = levelOf(total, input.scale);
      // write モードは全マスのバランスを 0 とみなす。スキームごとの特別扱いを要らなくするため
      const balance = params.mode === "write" ? 0 : balanceOf(minutes, input.center);
      const fill = scheme.cell({ level, balance, total }, params.theme);
      return rect(gridX + cell.column * STEP, gridY + cell.row * STEP, fill);
    })
    .join("");

  const legendX = PADDING + contentWidth - legend.width;
  const legendY = gridY + gridHeight + LEGEND_GAP;
  const legendParts = renderLegend(legendBalances, scheme, params.theme, legendX, legendY);

  const labels =
    monthLabels(cells)
      .map((label) => text(gridX + label.position * STEP, PADDING + LABEL_BASELINE, label.text))
      .join("") +
    WEEKDAY_LABELS.map((label) =>
      text(gridX - 4, gridY + label.position * STEP + LABEL_BASELINE, label.text, "end"),
    ).join("") +
    legendParts.labels;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<g data-part="labels" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${TEXT_COLOR[params.theme]}">${labels}</g>` +
    `<g data-part="grid">${gridRects}</g>` +
    `<g data-part="legend">${legendParts.cells}</g>` +
    "</svg>"
  );
}
