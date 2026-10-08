import { describe, expect, it } from "vitest";
import { percentages, sumAxes } from "../../../src/worker/graph/axes.ts";

describe("sumAxes", () => {
  it("期間を合計する。育てるは w − wc − wo", () => {
    expect(
      sumAxes([
        { w: 10, r: 5, wc: 2, wo: 3 },
        { w: 4, r: 1, wc: 0, wo: 0 },
      ]),
    ).toEqual({ grow: 9, create: 2, join: 3, read: 6 });
  });

  it("**wc + wo が w を超えた日は、育てるをその日のうちに 0 で打ち切る** (端末をまたいだ max のため)", () => {
    // 1 日目は 2 − 3 = −1 だが、2 日目の 5 から引かない
    expect(
      sumAxes([
        { w: 2, r: 0, wc: 2, wo: 1 },
        { w: 5, r: 0, wc: 0, wo: 0 },
      ]),
    ).toEqual({ grow: 5, create: 2, join: 1, read: 0 });
  });

  it("空なら全部 0", () => {
    expect(sumAxes([])).toEqual({ grow: 0, create: 0, join: 0, read: 0 });
  });
});

describe("percentages (最大剰余法)", () => {
  it("**合計は必ず 100** (四捨五入では 99 や 101 になる並び)", () => {
    // 四捨五入だと 33 + 33 + 33 = 99
    expect(percentages([1, 1, 1])).toEqual([34, 33, 33]);
    // 四捨五入だと 17 + 17 + 17 + 50 = 101
    expect(percentages([1, 1, 1, 3])).toEqual([17, 17, 16, 50]);
    for (const values of [
      [7, 13, 29, 51],
      [1, 2, 3, 1000],
      [3, 3, 3, 1],
    ]) {
      expect(percentages(values).reduce((a, b) => a + b, 0)).toBe(100);
    }
  });

  it("端数の大きい順に足し、同じなら並びの先 (上・右・下・左) を優先する", () => {
    expect(percentages([1, 2])).toEqual([33, 67]);
    expect(percentages([1, 1, 1, 0])).toEqual([34, 33, 33, 0]);
  });

  it("1 つだけなら 100、全部 0 なら全部 0", () => {
    expect(percentages([0, 5, 0, 0])).toEqual([0, 100, 0, 0]);
    expect(percentages([0, 0, 0, 0])).toEqual([0, 0, 0, 0]);
  });
});
