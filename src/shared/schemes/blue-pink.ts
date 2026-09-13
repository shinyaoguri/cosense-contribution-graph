/**
 * **既定の配色** — 青 → 藍 → 紫 → 赤紫 → ピンク (design §7、ADR-0016)。
 *
 * 読み寄りが青、書き寄りがピンク。**手で選んだ段階の色を表で指定する** ので、
 * blue-yellow のように暖色が暗い段で茶色に濁らない。
 *
 * **色覚への配慮は blue-yellow に劣る。** 青とピンクの軸は P 型・D 型色覚で見分けにくくなる
 * (ADR-0016)。色覚に配慮した配色は `?palette=blue-yellow` で選べる。
 *
 * 色は Tailwind CSS v3 のパレット (MIT License, Copyright (c) Tailwind Labs, Inc.) から取った。
 * ライトは 200 / 400 / 600 / 800、ダークは 900 / 700 / 500 / 300。
 */
import { bandScheme } from "./bands.ts";

export const bluePink = bandScheme({
  name: "blue-pink",
  bands: [
    // blue
    {
      light: ["#bfdbfe", "#60a5fa", "#2563eb", "#1e40af"],
      dark: ["#1e3a8a", "#1d4ed8", "#3b82f6", "#93c5fd"],
    },
    // indigo
    {
      light: ["#c7d2fe", "#818cf8", "#4f46e5", "#3730a3"],
      dark: ["#312e81", "#4338ca", "#6366f1", "#a5b4fc"],
    },
    // violet
    {
      light: ["#ddd6fe", "#a78bfa", "#7c3aed", "#5b21b6"],
      dark: ["#4c1d95", "#6d28d9", "#8b5cf6", "#c4b5fd"],
    },
    // fuchsia
    {
      light: ["#f5d0fe", "#e879f9", "#c026d3", "#86198f"],
      dark: ["#701a75", "#a21caf", "#d946ef", "#f0abfc"],
    },
    // pink
    {
      light: ["#fbcfe8", "#f472b6", "#db2777", "#9d174d"],
      dark: ["#831843", "#be185d", "#ec4899", "#f9a8d4"],
    },
  ],
  // 真ん中の紫を広めに取る。典型的な日 (バランス 0 付近) が紫にまとまる
  edges: [-0.6, -0.2, 0.2, 0.6],
  // Level 0 は GitHub と同じ。ダークは blue-yellow の #262624 より暗く、少ない日と見分けやすい
  level0: { light: "#ebedf0", dark: "#161b22" },
  legendBalances: [-1, -0.4, 0, 0.4, 1],
});
