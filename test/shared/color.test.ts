import { describe, expect, it } from "vitest";
import { cellColor, levelColor, SATURATION_MINUTES } from "../../src/shared/color.ts";

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

/** 相対的な明るさの目安。 */
function brightness(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe("Level 0", () => {
  it("色相を持たない固定色 (design §7)", () => {
    expect(levelColor(0, 1, 200, "light")).toBe("#ebedf0");
    expect(levelColor(0, 1, 200, "dark")).toBe("#262624");
  });
});

describe("明度のランプ", () => {
  it("light は Level が上がるほど暗い", () => {
    const levels = [1, 2, 3, 4] as const;
    const values = levels.map((l) => brightness(levelColor(l, 1, 155, "light")));
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });

  it("**dark は Level が上がるほど明るい**", () => {
    const levels = [1, 2, 3, 4] as const;
    const values = levels.map((l) => brightness(levelColor(l, 1, 155, "dark")));
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });
});

describe("彩度", () => {
  it("割合 0 は無彩色 (灰色)", () => {
    expect(spread(levelColor(2, 0, 155, "light"))).toBeLessThan(0.01);
  });

  it(`合計分数に比例し、${SATURATION_MINUTES} 分で飽和する`, () => {
    const day = (total: number) => ({ w: total / 2, r: total / 2 });
    const few = spread(cellColor(day(4), 3, 0, "light", "bi"));
    const saturated = spread(cellColor(day(SATURATION_MINUTES), 3, 0, "light", "bi"));
    const beyond = cellColor(day(SATURATION_MINUTES * 4), 3, 0, "light", "bi");

    expect(few).toBeLessThan(saturated);
    // 飽和点を超えても色は変わらない
    expect(beyond).toBe(cellColor(day(SATURATION_MINUTES), 3, 0, "light", "bi"));
  });
});

describe("モード", () => {
  const readHeavy = { w: 2, r: 40 };
  const writeHeavy = { w: 40, r: 2 };

  it("bi はバランスで色相が変わる", () => {
    expect(cellColor(readHeavy, 3, 0, "light", "bi")).not.toBe(
      cellColor(writeHeavy, 3, 0, "light", "bi"),
    );
  });

  it("write は色相を 155° に固定するだけ (明度と彩度はそのまま)", () => {
    // 合計が同じなら、バランスが違っても同じ色になる
    expect(cellColor(readHeavy, 3, 0, "light", "write")).toBe(
      cellColor(writeHeavy, 3, 0, "light", "write"),
    );
    expect(cellColor(readHeavy, 3, 0, "light", "write")).toBe(levelColor(3, 42 / 15, 155, "light"));
  });
});
