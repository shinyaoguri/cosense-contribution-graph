import { gam_sRGB, OKLab_to_XYZ, OKLCH_to_OKLab, XYZ_to_lin_sRGB } from "@csstools/color-helpers";
import { describe, expect, it } from "vitest";
import {
  fitChroma,
  inSrgbGamut,
  oklchToHex,
  oklchToLinearSrgb,
  oklchToSrgb,
  srgbToHex,
} from "../../../src/worker/graph/oklch.ts";

// 草を描くのは Worker だけなので workerd でだけ走る (ADR-0019)

/** リファレンス: CSS Color 4 仕様のサンプルコード (conversions.js) を移植した実装。同じ係数。 */
function referenceSrgb(l: number, c: number, h: number): readonly number[] {
  return gam_sRGB(XYZ_to_lin_sRGB(OKLab_to_XYZ(OKLCH_to_OKLab([l, c, h]))));
}

describe("OKLCH から sRGB への変換", () => {
  it("リファレンス実装と許容誤差 1e-12 で一致する", () => {
    // ランプの明度 (light と dark) × 彩度 0〜0.145 × 色相 360°。同じ係数・同じ演算順なので
    // 手元の計算では 17,280 色すべてで差が 0 だった
    const lightness = [0.32, 0.45, 0.58, 0.72, 0.88, 0.76, 0.63, 0.5];
    let maxDiff = 0;
    for (const l of lightness) {
      for (let step = 0; step <= 29; step++) {
        const c = step * 0.005;
        for (let h = 0; h < 360; h += 5) {
          const actual = oklchToSrgb(l, c, h);
          const expected = referenceSrgb(l, c, h);
          for (let i = 0; i < 3; i++) {
            maxDiff = Math.max(maxDiff, Math.abs((actual[i] ?? 0) - (expected[i] ?? 0)));
          }
        }
      }
    }

    expect(maxDiff).toBeLessThan(1e-12);
  });

  it("既知の色: 白・黒・sRGB の赤", () => {
    expect(oklchToHex(1, 0, 0)).toBe("#ffffff");
    expect(oklchToHex(0, 0, 0)).toBe("#000000");
    // CSS Color 4 の例で sRGB の赤 (#ff0000) は oklch(0.62796 0.25768 29.2339)
    expect(oklchToHex(0.62796, 0.25768, 29.2339)).toBe("#ff0000");
  });
});

describe("ガモット外の彩度を二分探索で詰める", () => {
  // **「高明度と青」だけでは足りない。** ランプの値で削られるのは全部下限側 (R か B が負) で、
  // 上限側 (1 を超える) はランプの Cmax では一度も起きない。両方を別々に確かめる

  it("上限側: L=0.88 C=0.145 H=235 は B が 1 を超えるので詰まる", () => {
    expect(inSrgbGamut(oklchToLinearSrgb(0.88, 0.145, 235))).toBe(false);

    const c = fitChroma(0.88, 0.145, 235);

    expect(c).toBeCloseTo(0.06906, 5);
    expect(inSrgbGamut(oklchToLinearSrgb(0.88, c, 235))).toBe(true);
    // 境界まで詰めている (少し足すとはみ出す)
    expect(inSrgbGamut(oklchToLinearSrgb(0.88, c + 1e-6, 235))).toBe(false);
  });

  it("下限側: L=0.50 C=0.145 H=200 は R が負になるので詰まる (ランプで最悪のケース)", () => {
    expect(inSrgbGamut(oklchToLinearSrgb(0.5, 0.145, 200))).toBe(false);

    const c = fitChroma(0.5, 0.145, 200);

    expect(c).toBeCloseTo(0.085, 5);
    expect(inSrgbGamut(oklchToLinearSrgb(0.5, c, 200))).toBe(true);
    expect(inSrgbGamut(oklchToLinearSrgb(0.5, c + 1e-6, 200))).toBe(false);
  });

  it("ガモット内の入力はそのまま返す (二分探索で丸めない)", () => {
    expect(fitChroma(0.63, 0.05, 155)).toBe(0.05);
  });

  it("彩度 0 (無彩色) はランプの明度で常にガモット内", () => {
    for (const l of [0.32, 0.45, 0.5, 0.58, 0.63, 0.72, 0.76, 0.88]) {
      expect(fitChroma(l, 0, 200)).toBe(0);
    }
  });

  it("詰めた色は必ず [0, 1] に収まり、16 進にしても潰れない", () => {
    for (let h = 75; h <= 235; h += 5) {
      const c = fitChroma(0.5, 0.145, h);
      const srgb = oklchToSrgb(0.5, c, h);
      for (const v of srgb) {
        expect(v).toBeGreaterThanOrEqual(-1e-6);
        expect(v).toBeLessThanOrEqual(1 + 1e-6);
      }
    }
  });
});

describe("16 進への焼き込み", () => {
  it("クランプしてから丸め、小文字 2 桁にする", () => {
    expect(srgbToHex([1.2, -0.1, 0.5])).toBe("#ff0080");
    expect(srgbToHex([0, 0.0019, 0.0021])).toBe("#000001");
  });

  it("oklch() の CSS 記法を出さない", () => {
    expect(oklchToHex(0.63, 0.12, 155)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
