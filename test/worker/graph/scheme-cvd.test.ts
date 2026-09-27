import { describe, expect, it } from "vitest";
import type { Level } from "../../../src/worker/graph/scale.ts";
import { type ColorScheme, SCHEMES, type Theme } from "../../../src/worker/graph/scheme.ts";

// **色覚の回帰テスト** (ADR-0023)。登録した全スキームを、P 型・D 型・T 型の色覚シミュレーションに
// かけてから OKLab の色差で比べる。色を手で直したときに、見分けやすさが黙って落ちるのを防ぐ。
//
// シミュレーションは Machado, Oliveira & Fernandes (2009) の重さ 1.0 の行列 (linear sRGB に掛ける)。
// 色差は OKLab のユークリッド距離を 100 倍した値 (ΔE)。小さな 1 マスでは 5 未満だとほぼ同じ色に見える。

type Vec3 = readonly [number, number, number];
type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

const VISIONS: Record<string, Mat3 | undefined> = {
  normal: undefined,
  protan: [
    0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998,
  ],
  deutan: [
    0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881,
  ],
  tritan: [
    1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039,
  ],
};

const THEMES: readonly Theme[] = ["light", "dark"];

function toLinear(hex: string): Vec3 {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return [lin(((n >> 16) & 255) / 255), lin(((n >> 8) & 255) / 255), lin((n & 255) / 255)];
}

function simulate(rgb: Vec3, m: Mat3 | undefined): Vec3 {
  if (m === undefined) {
    return rgb;
  }
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clamp(m[0] * rgb[0] + m[1] * rgb[1] + m[2] * rgb[2]),
    clamp(m[3] * rgb[0] + m[4] * rgb[1] + m[5] * rgb[2]),
    clamp(m[6] * rgb[0] + m[7] * rgb[1] + m[8] * rgb[2]),
  ];
}

/** linear sRGB → OKLab (Ottosson)。 */
function oklab([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function deltaE(a: string, b: string, vision: Mat3 | undefined): number {
  const x = oklab(simulate(toLinear(a), vision));
  const y = oklab(simulate(toLinear(b), vision));
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** 凡例の見本の列を読み寄りから順に並べた色。 */
function row(scheme: ColorScheme, level: Level, theme: Theme): string[] {
  return scheme.legendBalances.map((balance) => scheme.cell({ level, balance }, theme));
}

/** 両端と中間 (3 段階の読み取り) を、どの色覚でも見分けられる下限。実測の最小は P 型の 9 */
const ENDS_TO_MIDDLE_MIN = 8;
/** Level 1 が Level 0 (記録なし) と見分けられる下限。実測の最小は T 型の 5 */
const LEVEL1_TO_LEVEL0_MIN = 4.5;

describe.each(Object.values(SCHEMES) as ColorScheme[])(
  "スキーム $name の見分けやすさ",
  (scheme) => {
    it(`どの色覚でも、Level 2〜4 の両端と中間の色差が ${ENDS_TO_MIDDLE_MIN} 以上`, () => {
      for (const [name, vision] of Object.entries(VISIONS)) {
        for (const theme of THEMES) {
          for (const level of [2, 3, 4] as const) {
            const colors = row(scheme, level, theme);
            const first = colors[0] ?? "";
            const middle = colors[Math.floor(colors.length / 2)] ?? "";
            const last = colors[colors.length - 1] ?? "";
            const where = `${name} ${theme} Level ${level}`;
            expect(deltaE(first, middle, vision), where).toBeGreaterThanOrEqual(ENDS_TO_MIDDLE_MIN);
            expect(deltaE(middle, last, vision), where).toBeGreaterThanOrEqual(ENDS_TO_MIDDLE_MIN);
          }
        }
      }
    });

    it(`どの色覚でも、Level 1 と Level 0 の色差が ${LEVEL1_TO_LEVEL0_MIN} 以上`, () => {
      for (const [name, vision] of Object.entries(VISIONS)) {
        for (const theme of THEMES) {
          const level0 = scheme.cell({ level: 0, balance: 0 }, theme);
          for (const color of row(scheme, 1, theme)) {
            expect(
              deltaE(color, level0, vision),
              `${name} ${theme} ${color}`,
            ).toBeGreaterThanOrEqual(LEVEL1_TO_LEVEL0_MIN);
          }
        }
      }
    });

    it("列は読み寄りから順に遷移する (隣の列は、1 つ飛ばした列より近い)", () => {
      // 間の列が別の色相に飛ぶと、5 色がばらばらに見える (ADR-0023)
      for (const theme of THEMES) {
        for (const level of [1, 2, 3, 4] as const) {
          const colors = row(scheme, level, theme);
          for (let i = 0; i + 2 < colors.length; i++) {
            const [a, b, c] = [colors[i] ?? "", colors[i + 1] ?? "", colors[i + 2] ?? ""];
            const skip = deltaE(a, c, undefined);
            const where = `${theme} Level ${level} 列 ${i}`;
            expect(deltaE(a, b, undefined), where).toBeLessThan(skip);
            expect(deltaE(b, c, undefined), where).toBeLessThan(skip);
          }
        }
      }
    });
  },
);
