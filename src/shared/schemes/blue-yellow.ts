/**
 * **規則で色を計算するスキーム** — 青 ↔ 緑 ↔ 黄 (design §7)。
 *
 * 明度 = 活動量の Level、色相 = 読み書きのバランス、彩度 = 比率の確からしさ。
 * OKLCH で計算して sRGB のガモットに詰める。
 *
 * **色覚に配慮した軸。** 端点を青と黄に置くのは、P 型・D 型色覚で保たれるのがこの軸だから
 * (赤と青、赤と緑は差が潰れる)。代わりに明度を全色相で揃えるので、書き寄りの多い日は
 * 明度の低いところで茶色に濁る。
 */
import { oklchToHex } from "../oklch.ts";
import type { Level } from "../scale.ts";
import type { CellInput, ColorScheme, Theme } from "../scheme.ts";

type ColoredLevel = Exclude<Level, 0>;

// Level 0 は色相を持たない固定色 (design §7 の表)
const LEVEL0_HEX: Record<Theme, string> = { light: "#ebedf0", dark: "#262624" };

// 明度のランプ。**ダークは Level が上がるほど明るい** (design §7 の表)
const LIGHTNESS: Record<Theme, Record<ColoredLevel, number>> = {
  light: { 1: 0.88, 2: 0.76, 3: 0.63, 4: 0.5 },
  dark: { 1: 0.32, 2: 0.45, 3: 0.58, 4: 0.72 },
};

// 彩度の上限。docs の表が 1 列なのでライトとダークで共通 (design §7)
const CHROMA_MAX: Record<ColoredLevel, number> = { 1: 0.05, 2: 0.09, 3: 0.12, 4: 0.145 };

/** 合計がこの分数で彩度が最大になる。少ない分数では比が当てにならないので灰色に寄せる。**仮値** (design §15) */
export const SATURATION_MINUTES = 15;

// 色相は 155° を中心に ±80°。書き寄りで 75° (黄)、読み寄りで 235° (青) (design §7)
const HUE_CENTER = 155;
const HUE_SPAN = 80;

/** バランスを色相 (度) にする。-1 → 235° (青)、0 → 155° (緑)、+1 → 75° (黄)。 */
export function hueOf(balance: number): number {
  return HUE_CENTER - HUE_SPAN * balance;
}

/**
 * Level と彩度の割合と色相から色を作る。
 *
 * ガモット外の色は彩度を二分探索で詰めてから焼き込む。light の Level 4 は
 * 色相によって彩度が 0.085〜0.124 まで揺れる (#24)。
 */
export function levelColor(level: Level, chromaRatio: number, hue: number, theme: Theme): string {
  if (level === 0) {
    return LEVEL0_HEX[theme];
  }
  const chroma = CHROMA_MAX[level] * Math.min(1, Math.max(0, chromaRatio));
  return oklchToHex(LIGHTNESS[theme][level], chroma, hue);
}

export const blueYellow: ColorScheme = {
  name: "blue-yellow",
  legendBalances: [-1, -0.5, 0, 0.5, 1],
  // 彩度は合計分数に比例して SATURATION_MINUTES で飽和する。凡例は total = Infinity で飽和する。
  // write モード (バランス 0) では色相が 155° になり、design §7 の「色相を 155° に固定」と一致する
  cell({ level, balance, total }: CellInput, theme: Theme): string {
    return levelColor(level, total / SATURATION_MINUTES, hueOf(balance), theme);
  },
};
