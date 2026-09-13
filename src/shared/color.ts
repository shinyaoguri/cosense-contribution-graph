/**
 * セルの色を決める (design §7)。明度 = 活動量の Level、色相 = バランス、彩度 = 比率の確からしさ。
 * 両 lib で型検査され、両環境でテストされる。
 */
import { balanceOf, hueOf, type Minutes } from "./balance.ts";
import { oklchToHex } from "./oklch.ts";
import type { Level } from "./scale.ts";

export type Theme = "light" | "dark";

/** `bi` は 2 次元 (色相がバランス)、`write` は色相を 155° に固定した単色 (design §6)。 */
export type Mode = "bi" | "write";

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

const WRITE_MODE_HUE = 155;

/**
 * Level と彩度の割合と色相から色を作る。凡例はこれを割合 1 (飽和) で呼ぶ。
 *
 * ガモット外の色は彩度を二分探索で詰めてから焼き込む。light の Level 4 は
 * 色相によって彩度が 0.085〜0.124 まで揺れる (ランプの調整は段階 7)。
 */
export function levelColor(level: Level, chromaRatio: number, hue: number, theme: Theme): string {
  if (level === 0) {
    return LEVEL0_HEX[theme];
  }
  const chroma = CHROMA_MAX[level] * Math.min(1, Math.max(0, chromaRatio));
  return oklchToHex(LIGHTNESS[theme][level], chroma, hue);
}

/**
 * 1 日のマスの色。
 *
 * 彩度は合計分数に比例して `SATURATION_MINUTES` で飽和する。バランスは彩度に効かせない。
 * `mode = "write"` は**色相を 155° に固定するだけ**で、明度と彩度はそのまま使う (design §7)。
 */
export function cellColor(
  day: Minutes,
  level: Level,
  center: number,
  theme: Theme,
  mode: Mode,
): string {
  const total = day.w + day.r;
  const hue = mode === "write" ? WRITE_MODE_HUE : hueOf(balanceOf(day, center));
  return levelColor(level, total / SATURATION_MINUTES, hue, theme);
}
