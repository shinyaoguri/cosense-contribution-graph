import { describe, expect, it } from "vitest";
import { balanceOf, centerOf, oddsOf } from "../../src/shared/balance.ts";

describe("対数オッズ", () => {
  it("読みと書きが同じなら 0", () => {
    expect(oddsOf({ w: 10, r: 10 })).toBe(0);
  });

  it("書き寄りは正、読み寄りは負", () => {
    expect(oddsOf({ w: 30, r: 5 })).toBeGreaterThan(0);
    expect(oddsOf({ w: 5, r: 30 })).toBeLessThan(0);
  });
});

describe("バランスの中心", () => {
  it("母集団が空なら 0", () => {
    expect(centerOf([])).toBe(0);
  });

  it("デッドゾーン未満の日は中心の計算に使わない", () => {
    // 合計 2 分の極端な書き寄りの日が混ざっても中心は動かない
    const days = [
      { w: 5, r: 5 },
      { w: 5, r: 5 },
    ];
    expect(centerOf([...days, { w: 2, r: 0 }])).toBe(centerOf(days));
  });

  it("**典型的な日 (読みが多い) のバランスが 0 になるよう、中心を自分の中央値に置く**", () => {
    // 読みと書きが 6 対 1 程度の人。素朴な w / (w + r) なら全日が読み寄りに振れる。
    // どの色になるかはスキームの関心なので、ここではバランスだけを見る
    const typical = { w: 5, r: 30 };
    const center = centerOf([typical, typical, typical, { w: 2, r: 40 }, { w: 10, r: 25 }]);

    expect(balanceOf(typical, center)).toBeCloseTo(0, 6);
  });
});

describe("バランスと色相", () => {
  it("バランスは -1 .. +1 に収まる", () => {
    const center = 0;
    expect(balanceOf({ w: 1000, r: 0 }, center)).toBeLessThan(1);
    expect(balanceOf({ w: 1000, r: 0 }, center)).toBeGreaterThan(0.9);
    expect(balanceOf({ w: 0, r: 1000 }, center)).toBeGreaterThan(-1);
    expect(balanceOf({ w: 0, r: 1000 }, center)).toBeLessThan(-0.9);
  });
});
