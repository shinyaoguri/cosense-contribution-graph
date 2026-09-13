import { describe, expect, it } from "vitest";
import {
  blueYellow,
  hueOf,
  levelColor,
  SATURATION_MINUTES,
} from "../../src/shared/schemes/blue-yellow.ts";

// 規則で色を計算するスキーム (青 ↔ 緑 ↔ 黄)。スキームに共通の性質は scheme.test.ts が見る

/** `#rrggbb` を 0..1 のチャネルにする。 */
function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** チャネルのばらつき。0 に近いほど灰色 (彩度が低い)。 */
function spread(hex: string): number {
  const [r, g, b] = channels(hex);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

describe("色相", () => {
  it("読み -1 → 235° (青)、0 → 155° (緑)、書き +1 → 75° (黄)", () => {
    expect(hueOf(-1)).toBe(235);
    expect(hueOf(0)).toBe(155);
    expect(hueOf(1)).toBe(75);
  });
});

describe("Level 0", () => {
  it("色相を持たない固定色 (design §7)", () => {
    expect(blueYellow.cell({ level: 0, balance: 1, total: 99 }, "light")).toBe("#ebedf0");
    expect(blueYellow.cell({ level: 0, balance: 1, total: 99 }, "dark")).toBe("#262624");
  });
});

describe("彩度", () => {
  it("割合 0 は無彩色 (灰色)", () => {
    expect(spread(levelColor(2, 0, 155, "light"))).toBeLessThan(0.01);
  });

  it(`合計分数に比例し、${SATURATION_MINUTES} 分で飽和する`, () => {
    const cell = (total: number) => blueYellow.cell({ level: 3, balance: 0, total }, "light");

    expect(spread(cell(4))).toBeLessThan(spread(cell(SATURATION_MINUTES)));
    // 飽和点を超えても、凡例の Infinity でも色は変わらない
    expect(cell(SATURATION_MINUTES * 4)).toBe(cell(SATURATION_MINUTES));
    expect(cell(Number.POSITIVE_INFINITY)).toBe(cell(SATURATION_MINUTES));
  });
});

describe("バランス", () => {
  it("バランスで色相が変わる", () => {
    const at = (balance: number) => blueYellow.cell({ level: 3, balance, total: 42 }, "light");

    expect(at(-1)).not.toBe(at(1));
  });

  it("**バランス 0 は、段階 1 の「write モードは色相を 155° に固定する」と同じ色**", () => {
    // スキームに分けたとき、write モードを「バランス 0 とみなす」に置き換えた。その同値性を固定する
    for (const level of [1, 2, 3, 4] as const) {
      for (const total of [3, 15, 42]) {
        expect(blueYellow.cell({ level, balance: 0, total }, "light")).toBe(
          levelColor(level, total / SATURATION_MINUTES, 155, "light"),
        );
      }
    }
  });
});
