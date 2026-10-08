import { describe, expect, it } from "vitest";
import { fromEpochDay, toEpochDay, weekdayOf } from "../../../src/shared/epoch-day.ts";
import { MAX_USER_NAME_LENGTH } from "../../../src/shared/project-name.ts";
import { balanceOf } from "../../../src/worker/graph/balance.ts";
import {
  estimateWidth,
  type GrassDay,
  type GrassInput,
  grassStart,
  HALF_WEEKS,
  layoutGrass,
  slotPopulation,
  slotsOf,
} from "../../../src/worker/graph/grass.ts";
import { levelOf, type Scale } from "../../../src/worker/graph/scale.ts";
import { DEFAULT_SCHEME, schemeOf } from "../../../src/worker/graph/scheme.ts";
import type { Quad } from "../../../src/worker/segments.ts";

/** 水曜。右端の列が欠ける */
const TODAY = "2026-09-16";
const day = (offset: number) => fromEpochDay(toEpochDay(TODAY) + offset);

const SCALE: Scale = { q1: 10, q2: 20, q3: 30 };
const scheme = schemeOf(DEFAULT_SCHEME);

function withSegments(w: Quad, r: Quad, extra: Partial<GrassDay> = {}): GrassDay {
  const sum = (q: Quad) => q[0] + q[1] + q[2] + q[3];
  return { w: sum(w), r: sum(r), wc: 0, wo: 0, segments: { w, r }, ...extra };
}

function input(overrides: Partial<GrassInput> = {}): GrassInput {
  return {
    today: TODAY,
    days: new Map(),
    slotScale: SCALE,
    slotCenter: 0,
    dayScale: SCALE,
    dayCenter: 0,
    theme: "light",
    palette: DEFAULT_SCHEME,
    lang: "ja",
    ...overrides,
  };
}

const cellsOf = (layout: ReturnType<typeof layoutGrass>, d: string) =>
  layout.grid.filter((cell) => cell.day === d);

describe("夜の組み立て (slotsOf)", () => {
  const days = new Map<string, GrassDay>([
    [day(-2), withSegments([1, 2, 3, 4], [10, 20, 30, 40])],
    [day(-1), withSegments([5, 6, 7, 8], [50, 60, 70, 80])],
    [TODAY, withSegments([9, 0, 0, 11], [90, 0, 0, 110])],
  ]);

  it("**夜は D の区間 3 + D+1 の区間 0**。朝は区間 1、昼は区間 2", () => {
    expect(slotsOf(days, day(-2), TODAY)).toEqual([
      { w: 2, r: 20 },
      { w: 3, r: 30 },
      { w: 4 + 5, r: 40 + 50 },
    ]);
  });

  it("**今日の夜は D の区間 3 だけ** (翌日は表示範囲の外)", () => {
    expect(slotsOf(days, TODAY, TODAY)?.[2]).toEqual({ w: 11, r: 110 });
    // 翌日の行があっても足さない (端末の時計が進んでいる場合など)
    const ahead = new Map(days).set(day(1), withSegments([100, 0, 0, 0], [100, 0, 0, 0]));
    expect(slotsOf(ahead, TODAY, TODAY)?.[2]).toEqual({ w: 11, r: 110 });
  });

  it("翌日の行が無いか内訳なしなら 0 を足す。D が内訳なしなら undefined", () => {
    const sparse = new Map<string, GrassDay>([
      [day(-5), withSegments([0, 0, 0, 4], [0, 0, 0, 1])],
      [day(-3), withSegments([0, 0, 0, 2], [0, 0, 0, 2])],
      [day(-2), { w: 9, r: 9, wc: 0, wo: 0 }],
    ]);
    expect(slotsOf(sparse, day(-5), TODAY)?.[2]).toEqual({ w: 4, r: 1 });
    expect(slotsOf(sparse, day(-3), TODAY)?.[2]).toEqual({ w: 2, r: 2 });
    expect(slotsOf(sparse, day(-2), TODAY)).toBeUndefined();
    expect(slotsOf(sparse, day(-4), TODAY)).toBeUndefined();
  });

  it("母集団は内訳のある日の 朝・昼・夜 を並べ、翌日の区間 0 を夜に足す", () => {
    expect(slotPopulation(days)).toEqual([
      { w: 2, r: 20 },
      { w: 3, r: 30 },
      { w: 9, r: 90 },
      { w: 6, r: 60 },
      { w: 7, r: 70 },
      { w: 17, r: 170 },
      { w: 0, r: 0 },
      { w: 0, r: 0 },
      { w: 11, r: 110 },
    ]);
  });
});

describe("草のマス", () => {
  it("**行は月曜始まり**。左端の列は月曜から始まり欠けず、右端は今日で終わる", () => {
    const layout = layoutGrass(input());
    const first = layout.grid[0];
    const last = layout.grid.at(-1);

    expect(first?.day).toBe(grassStart(TODAY, HALF_WEEKS));
    expect(weekdayOf(toEpochDay(first?.day ?? ""))).toBe(1);
    expect(last?.day).toBe(TODAY);
    const dayCount = toEpochDay(TODAY) - toEpochDay(grassStart(TODAY, HALF_WEEKS)) + 1;
    expect(layout.grid).toHaveLength(dayCount * 3);
    // 26 列。月曜 (2026-09-14) の列が右端
    expect(Math.floor(dayCount / 7)).toBe(HALF_WEEKS - 1);

    // 月曜は最上段、日曜は最下段
    const monday = cellsOf(layout, day(-2));
    const sunday = cellsOf(layout, day(-3));
    expect(monday.map((c) => c.y)[0]).toBe(40);
    expect(Math.max(...sunday.map((c) => c.y + layout.cellHeight))).toBeCloseTo(304, 1);
    expect(monday.map((c) => c.shape)).toEqual(["top", "middle", "bottom"]);
  });

  it("時間帯のマスは、組み立てた分から Level と釣り合いを取って塗る", () => {
    const days = new Map<string, GrassDay>([
      [day(-2), withSegments([0, 25, 0, 2], [0, 0, 4, 3])],
      [day(-1), withSegments([1, 0, 0, 0], [5, 0, 0, 0])],
    ]);
    const cells = cellsOf(layoutGrass(input({ days })), day(-2));

    expect(cells.map((c) => c.minutes)).toEqual([
      { w: 25, r: 0 },
      { w: 0, r: 4 },
      { w: 3, r: 8 },
    ]);
    for (const cell of cells) {
      const m = cell.minutes ?? { w: 0, r: 0 };
      const level = levelOf(m.w + m.r, SCALE);
      expect(level).toBeGreaterThan(0);
      expect(cell.fill).toBe(scheme.cell({ level, balance: balanceOf(m, 0) }, "light"));
      expect(cell.opacity).toBeUndefined();
    }
  });

  it("**内訳なしの日は、日の合計の色を 3 マスに薄く塗る**", () => {
    const whole: GrassDay = { w: 20, r: 5, wc: 0, wo: 0 };
    const cells = cellsOf(
      layoutGrass(input({ days: new Map([[day(-2), whole]]), dayCenter: 0.3 })),
      day(-2),
    );
    const expected = scheme.cell(
      { level: levelOf(25, SCALE), balance: balanceOf(whole, 0.3) },
      "light",
    );

    expect(cells.map((c) => [c.fill, c.opacity])).toEqual([
      [expected, 0.35],
      [expected, 0.35],
      [expected, 0.35],
    ]);
  });

  it("行の無い日と 0 分の時間帯は空きマス (朝 → 昼 → 夜 の順に濃くなる灰色)", () => {
    const days = new Map<string, GrassDay>([[day(-2), withSegments([0, 0, 0, 0], [0, 0, 0, 0])]]);
    const layout = layoutGrass(input({ days }));
    const empty = ["#f6f8fa", "#eff1f4", "#e6e9ed"];

    expect(cellsOf(layout, day(-2)).map((c) => c.fill)).toEqual(empty);
    expect(cellsOf(layout, day(-1)).map((c) => c.fill)).toEqual(empty);
    expect(cellsOf(layoutGrass(input({ theme: "dark" })), day(-1)).map((c) => c.fill)).toEqual([
      "#161b22",
      "#1b2028",
      "#21262d",
    ]);
  });

  it("「計」の列は曜日 × 時間帯の合計で、最大を一番濃くする", () => {
    const days = new Map<string, GrassDay>([
      // 月曜の朝に 30 分、火曜の昼に 10 分
      [day(-2), withSegments([0, 30, 0, 0], [0, 0, 0, 0])],
      [day(-8), withSegments([0, 0, 0, 0], [0, 0, 10, 0])],
    ]);
    const sum = layoutGrass(input({ days })).sum;

    expect(sum).toHaveLength(21);
    expect(sum[0]?.fill).toBe("rgba(87,96,106,0.88)");
    expect(sum[3 + 1]?.fill).toBe("rgba(87,96,106,0.347)");
    expect(sum[2]?.fill).toBe("rgba(87,96,106,0.08)");
  });
});

describe("ラベル", () => {
  it("**lang=en で曜日・月・「計」が英語になる**", () => {
    const ja = layoutGrass(input()).labels.map((l) => l.text);
    const en = layoutGrass(input({ lang: "en" })).labels.map((l) => l.text);

    expect(ja).toEqual(expect.arrayContaining(["月", "日", "4月", "計"]));
    expect(en).toEqual(expect.arrayContaining(["Mon", "Sun", "Apr", "Sum"]));
    expect(en).not.toContain("月");
  });

  const monthLabels = (today: string) =>
    layoutGrass(input({ today }))
      .labels.filter((l) => /月$/.test(l.text) && l.text.length > 1)
      .map((l) => ({ text: l.text, x: l.x, anchor: l.anchor }));

  it("**月ラベルはその月の 1 日を含む列に出す** (#208)", () => {
    // 範囲は 2026-03-23 から。各月の 1 日 (4/1 は水曜) を含む列に出る
    expect(monthLabels(input().today).map((l) => l.text)).toEqual([
      "4月",
      "5月",
      "6月",
      "7月",
      "8月",
      "9月",
    ]);

    // 10/1 (木) は右から 2 列目 (9/28 の週) にある。月曜が 1〜7 日の列 (右端) に限ると出せなかった
    const october = monthLabels("2026-10-07").find((l) => l.text === "10月");
    expect(october?.anchor).toBe("start");
    const september = monthLabels("2026-10-07").find((l) => l.text === "9月");
    // 9/1 (火) は 8/31 の週。10 月のラベルは 9 月のラベルの 4 列あと
    expect((october?.x ?? 0) - (september?.x ?? 0)).toBeGreaterThan(0);
  });

  it("**右端の列の月ラベルは右端をそろえ、「計」の見出しと重ねない**", () => {
    // 12/1 (火) は右端の列 (11/30 の週)
    const december = monthLabels("2026-12-02").find((l) => l.text === "12月");
    expect(december?.anchor).toBe("end");
    const sum = layoutGrass(input({ today: "2026-12-02" })).labels.find((l) => l.text === "計");
    expect(december?.x ?? Number.POSITIVE_INFINITY).toBeLessThan(sum?.x ?? 0);
  });

  it("**まだ来ていない 1 日には月ラベルを出さない**", () => {
    // 10/1 (木) は 9/30 から見ると明日
    expect(monthLabels("2026-09-30").map((l) => l.text)).not.toContain("10月");
    expect(monthLabels("2026-10-01").map((l) => l.text)).toContain("10月");
  });
});

describe("4 軸の線", () => {
  const axisOf = (create: number, grow: number, join: number, read: number) => {
    // 育てる = w − wc − wo なので、w に 3 つを足して渡す
    const days = new Map<string, GrassDay>([
      [day(-1), { w: create + grow + join, r: read, wc: create, wo: join }],
    ]);
    return layoutGrass(input({ days })).axis;
  };
  const visible = (line: { x1: number; x2: number }) => line.x2 - line.x1 + 3;

  it("**全体に対する割合で長さを分ける。0 の軸は区間を作らない**", () => {
    const axis = axisOf(100, 0, 100, 200);

    expect(axis.lines.map((l) => l.stroke)).toEqual(["#6e7781", "#b8c0c8", "#d8dde2"]);
    const lengths = axis.lines.map(visible);
    expect(lengths[0]).toBeCloseTo(lengths[1] ?? 0, 1);
    expect(lengths[2]).toBeCloseTo((lengths[0] ?? 0) * 2, 1);
    // 左端は草の左端、右端は「計」の列の右端。区間の間は 3
    expect((axis.lines[0]?.x1 ?? 0) - 1.5).toBeCloseTo(56, 1);
    expect((axis.lines[1]?.x1 ?? 0) - 1.5 - ((axis.lines[0]?.x2 ?? 0) + 1.5)).toBeCloseTo(3, 1);
    expect(axis.names.map((n) => n.text)).toEqual(["作る", "関わる", "読む"]);
  });

  it("**名前が区間の幅に収まらなければ省く**", () => {
    const axis = axisOf(1, 0, 0, 1000);

    expect(axis.lines).toHaveLength(2);
    expect(axis.names.map((n) => n.text)).toEqual(["読む"]);
  });

  it("全部 0 なら、ごく淡い 1 本の線だけで名前は無い", () => {
    const axis = axisOf(0, 0, 0, 0);

    expect(axis.lines).toEqual([{ x1: 57.5, x2: expect.any(Number), stroke: "#c8cfd6" }]);
    expect(axis.names).toEqual([]);
  });

  it("期間 (26 週) の外の日は数えない", () => {
    const days = new Map<string, GrassDay>([
      [day(-1), { w: 0, r: 10, wc: 0, wo: 0 }],
      [fromEpochDay(toEpochDay(grassStart(TODAY, HALF_WEEKS)) - 1), { w: 50, r: 0, wc: 50, wo: 0 }],
    ]);
    const axis = layoutGrass(input({ days })).axis;

    expect(axis.lines).toHaveLength(1);
    expect(axis.names.map((n) => n.text)).toEqual(["読む"]);
  });
});

describe("名前の行", () => {
  const gridRight = (layout: ReturnType<typeof layoutGrass>) =>
    Math.max(...layout.grid.map((c) => c.x)) + layout.cellWidth;

  it("`/プロジェクト名`・アイコン・ユーザー名 (`@` なし) の順。プロジェクト名はリンクを持つ", () => {
    const name = layoutGrass(
      input({ label: "my-proj", user: "taro", icon: "data:image/png;base64,AA==" }),
    ).name;

    expect(name.project?.text).toBe("/my-proj");
    expect(name.project?.href).toBe("https://scrapbox.io/my-proj/");
    expect(name.icon?.href).toBe("data:image/png;base64,AA==");
    expect(name.user?.text).toBe("taro");
    expect(name.project?.x ?? 0).toBeLessThan((name.icon?.cx ?? 0) - 8);
    expect((name.icon?.cx ?? 0) + 8).toBeLessThan(name.user?.x ?? 0);
    expect(name.mark).toEqual([]);
  });

  it("アイコンが無ければユーザー名だけ。名前が無ければ何も描かない", () => {
    const noIcon = layoutGrass(input({ label: "p", user: "taro" })).name;
    expect(noIcon.icon).toBeUndefined();
    expect(noIcon.user?.text).toBe("taro");

    const none = layoutGrass(input({ icon: "data:image/png;base64,AA==" })).name;
    expect([none.project, none.icon, none.user, none.mark.length]).toEqual([
      undefined,
      undefined,
      undefined,
      0,
    ]);
  });

  it("**長い名前は `…` を付けて切り、草の右端を超えない**", () => {
    const user = "漢".repeat(MAX_USER_NAME_LENGTH);
    const layout = layoutGrass(
      input({ label: "a".repeat(64), user, icon: "data:image/png;base64,AA==" }),
    );
    const { project, user: shown } = layout.name;

    expect(project?.text.endsWith("…")).toBe(true);
    expect(shown?.text.endsWith("…")).toBe(true);
    expect(
      (shown?.x ?? 0) + estimateWidth(shown?.text ?? "", shown?.size ?? 0),
    ).toBeLessThanOrEqual(gridRight(layout) + 0.01);
    // リンク先は切らない
    expect(project?.href).toBe(`https://scrapbox.io/${"a".repeat(64)}/`);
  });

  it("短い名前は切らない", () => {
    const name = layoutGrass(input({ label: "a".repeat(20), user: "b".repeat(20) })).name;
    expect([name.project?.text, name.user?.text]).toEqual([`/${"a".repeat(20)}`, "b".repeat(20)]);
  });

  it("**合算はプロジェクト名の代わりに合算の印を描き、アイコンを入れない**", () => {
    const name = layoutGrass(
      input({ total: true, label: "p", user: "taro", icon: "data:image/png;base64,AA==" }),
    ).name;

    expect(name.mark).toHaveLength(3);
    expect(name.mark.every((s) => s.x >= 56 && s.x < 56 + 11)).toBe(true);
    expect(name.project).toBeUndefined();
    expect(name.icon).toBeUndefined();
    expect(name.user?.text).toBe("taro");
    expect(name.user?.x ?? 0).toBeGreaterThan(56 + 11);
  });
});
