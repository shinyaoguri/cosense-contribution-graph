import { describe, expect, it } from "vitest";
import {
  layoutOverview,
  type OverviewTotals,
  percentages,
  sumOverview,
} from "../../../src/worker/graph/overview.ts";
import { DEFAULT_SCHEME, schemeOf } from "../../../src/worker/graph/scheme.ts";

function layout(totals: Partial<OverviewTotals>, theme: "light" | "dark" = "light") {
  return layoutOverview({
    totals: { grow: 0, create: 0, join: 0, read: 0, ...totals },
    theme,
    palette: DEFAULT_SCHEME,
  });
}

/** ラベルを「軸名 %」の並び (上・右・下・左) にする。 */
const labelsOf = (l: ReturnType<typeof layout>) =>
  l.labels.map((label) =>
    label.percent === undefined ? label.name : `${label.name} ${label.percent}%`,
  );

describe("sumOverview", () => {
  it("期間を合計する。育てるは w − wc − wo", () => {
    expect(
      sumOverview([
        { w: 10, r: 5, wc: 2, wo: 3 },
        { w: 4, r: 1, wc: 0, wo: 0 },
      ]),
    ).toEqual({ grow: 9, create: 2, join: 3, read: 6 });
  });

  it("**wc + wo が w を超えた日は、育てるをその日のうちに 0 で打ち切る** (端末をまたいだ max のため)", () => {
    // 1 日目は 2 − 3 = −1 だが、2 日目の 5 から引かない
    expect(
      sumOverview([
        { w: 2, r: 0, wc: 2, wo: 1 },
        { w: 5, r: 0, wc: 0, wo: 0 },
      ]),
    ).toEqual({ grow: 5, create: 2, join: 1, read: 0 });
  });

  it("空なら全部 0", () => {
    expect(sumOverview([])).toEqual({ grow: 0, create: 0, join: 0, read: 0 });
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

describe("layoutOverview", () => {
  it("**十字の配置は上 関わる / 右 読む / 下 作る / 左 育てる**", () => {
    const l = layout({ grow: 10, create: 20, join: 30, read: 40 });
    expect(labelsOf(l)).toEqual(["関わる 30%", "読む 40%", "作る 20%", "育てる 10%"]);
    const [top, right, bottom, left] = l.labels;
    expect(top?.y).toBeLessThan(right?.y ?? 0);
    expect(bottom?.y).toBeGreaterThan(right?.y ?? 0);
    expect(left?.x).toBeLessThan(top?.x ?? 0);
    expect([left?.anchor, top?.anchor, right?.anchor]).toEqual(["end", "middle", "start"]);
  });

  it("**長さは値 ÷ 最大値の線形で、最大の軸が端に届く**", () => {
    const l = layout({ grow: 35, create: 70, join: 0, read: 14 });
    // 中心 (150, 110)、端まで 70
    expect(l.shape).toEqual([
      { x: 150, y: 110 },
      { x: 164, y: 110 },
      { x: 150, y: 180 },
      { x: 115, y: 110 },
    ]);
  });

  it("**0 の軸は % も頂点の円も出さず、頂点を中心に置く。軸名は出す**", () => {
    const l = layout({ read: 5 });
    expect(labelsOf(l)).toEqual(["関わる", "読む 100%", "作る", "育てる"]);
    expect(l.vertices).toEqual([{ x: 220, y: 110 }]);
  });

  it("**全部 0 なら四角形も頂点も無く、十字と軸名だけ**", () => {
    const l = layout({});
    expect(l.shape).toBeUndefined();
    expect(l.vertices).toEqual([]);
    expect(l.axes).toHaveLength(2);
    expect(labelsOf(l)).toEqual(["関わる", "読む", "作る", "育てる"]);
  });

  it("色は配色の量の帯の Level 3 (バランス 0) で、テーマに従う", () => {
    for (const theme of ["light", "dark"] as const) {
      const expected = schemeOf(DEFAULT_SCHEME).cell(
        { level: 3, balance: 0, total: Number.POSITIVE_INFINITY },
        theme,
      );
      expect(layout({ read: 1 }, theme).shapeColor).toBe(expected);
    }
    expect(layout({}, "light").textColor).not.toBe(layout({}, "dark").textColor);
  });

  it("寸法は 300 × 220 で、ラベルが画像の中に収まる", () => {
    const l = layout({ grow: 1, create: 1, join: 1, read: 1 });
    expect([l.width, l.height]).toEqual([300, 220]);
    for (const label of l.labels) {
      expect(label.y).toBeGreaterThan(l.fontSize);
      expect(label.y).toBeLessThanOrEqual(l.height);
    }
    // 左の軸名 (右寄せ) は「育てる 100%」でも約 60px なので、左端から 60px 以上離す
    const left = l.labels[3];
    expect(left?.x).toBeGreaterThanOrEqual(60);
  });
});
