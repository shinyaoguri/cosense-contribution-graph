import { describe, expect, it } from "vitest";
import type { AxisTotals } from "../../../src/worker/graph/axes.ts";
import { layoutOverview } from "../../../src/worker/graph/overview.ts";
import { DEFAULT_SCHEME, schemeOf } from "../../../src/worker/graph/scheme.ts";

function layout(totals: Partial<AxisTotals>, theme: "light" | "dark" = "light") {
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

  it("**長さは値 ÷ 最大値の平方根で、最大の軸が端に届く** (ADR-0021 の改訂)", () => {
    const l = layout({ grow: 35, create: 70, join: 0, read: 14 });
    // 中心 (150, 110)、端まで 70。読む √0.2 × 70 = 31.3、育てる √0.5 × 70 = 49.5 (線形なら 14 と 35)
    expect(l.shape).toEqual([
      { x: 150, y: 110 },
      { x: 181.3, y: 110 },
      { x: 150, y: 180 },
      { x: 100.5, y: 110 },
    ]);
  });

  it("**最大の 1 % しかない軸も、端までの 1 割の長さで描く** (線形なら 0.7px で点に潰れる)", () => {
    const l = layout({ grow: 1, read: 100 });
    // 左の育てる: √0.01 × 70 = 7
    expect(l.shape?.[3]).toEqual({ x: 143, y: 110 });
    // % は時間の割合のまま
    expect(labelsOf(l)).toEqual(["関わる", "読む 99%", "作る", "育てる 1%"]);
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
      const expected = schemeOf(DEFAULT_SCHEME).cell({ level: 3, balance: 0 }, theme);
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
