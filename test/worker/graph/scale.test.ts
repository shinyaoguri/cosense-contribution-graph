import { describe, expect, it } from "vitest";
import { buildScale, levelOf, MIN_MINUTES, quantile } from "../../../src/worker/graph/scale.ts";

// 期待値はすべて手で計算してある (線形補間 type 7、フェンス Q3 + 1.5 × IQR)

/** 母集団からスケールを作り、各値の Level を返す。 */
function levels(population: number[], values: number[]): number[] {
  const scale = buildScale(population);
  return values.map((v) => levelOf(v, scale));
}

describe("分位点 (type 7)", () => {
  it("線形補間する", () => {
    expect(quantile([3, 3, 4], 0.75)).toBe(3.5);
    expect(quantile([3, 30, 60], 0.25)).toBe(16.5);
  });

  it("p = 0.5 は偶数個なら中央 2 つの平均", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  it("空の配列は拒否する", () => {
    expect(() => quantile([], 0.5)).toThrow(RangeError);
  });
});

describe("比較は <= (design §7)", () => {
  it("[3,3,3,3] は四分位が 3 に潰れ、3 の日は Level 1 (< だと全部 Level 4 になる)", () => {
    expect(levels([3, 3, 3, 3], [3])).toEqual([1]);
  });

  it("[5] は 1 日だけでも Level 1", () => {
    expect(levels([5], [5])).toEqual([1]);
  });

  it("[3,3,4] は 3 → Level 1、4 → Level 4", () => {
    expect(levels([3, 3, 4], [3, 4])).toEqual([1, 4]);
  });

  it("[3,100] は四分位が補間され、3 → Level 1、100 → Level 4", () => {
    expect(levels([3, 100], [3, 100])).toEqual([1, 4]);
  });
});

describe("外れ値のフェンス", () => {
  it("[3,3,3,3,100] はフェンスで 100 が落ち、四分位は 3 のまま。100 の日は Level 4", () => {
    expect(buildScale([3, 3, 3, 3, 100])).toEqual({ q1: 3, q2: 3, q3: 3 });
    expect(levels([3, 3, 3, 3, 100], [3, 100])).toEqual([1, 4]);
  });

  it("値が 1 種類に潰れても母集団が空にならない (フェンスは <= で残す)", () => {
    // < にするとフェンス = Q3 = 3 で全部落ち、四分位が +∞ になってしまう
    expect(buildScale([3, 3, 3, 3])).toEqual({ q1: 3, q2: 3, q3: 3 });
  });
});

describe("デッドゾーン", () => {
  it(`合計が ${MIN_MINUTES} 分未満は Level 0`, () => {
    expect(levels([10, 20, 30], [0, 1, 2])).toEqual([0, 0, 0]);
  });

  it("デッドゾーン未満の日を母集団から外す。外さないと 3・30・60 が全部 Level 4 になる", () => {
    // 0 だけ除外なら四分位は 1.25 / 2 / 2.75 で、3 以上が全部 Level 4 になる
    expect(levels([1, 1, 2, 2, 3, 30, 60], [3, 30, 60])).toEqual([1, 2, 4]);
  });
});

describe("母集団が空", () => {
  it("四分位を +∞ にして、3 分以上の日は Level 1 にする (データを隠さない)", () => {
    expect(levels([], [0, 3, 500])).toEqual([0, 1, 1]);
    expect(levels([1, 2], [3])).toEqual([1]);
  });
});
