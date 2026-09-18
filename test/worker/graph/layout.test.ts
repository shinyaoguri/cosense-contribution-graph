import { describe, expect, it } from "vitest";
import { fromEpochDay, toEpochDay } from "../../../src/shared/epoch-day.ts";
import type { Minutes } from "../../../src/worker/graph/balance.ts";
import { DAYS, DEFAULT_PARAMS, MAX_WEEKS } from "../../../src/worker/graph/grid.ts";
import { type GraphInput, layoutGraph, START_NOTE } from "../../../src/worker/graph/layout.ts";
import { buildScale } from "../../../src/worker/graph/scale.ts";

const TODAY = "2026-09-15";

/** 表示範囲の最初の日 (53 週) */
const RANGE_START = fromEpochDay(toEpochDay(TODAY) - DAYS * (MAX_WEEKS - 1));

const day = (offsetFromToday: number) => fromEpochDay(toEpochDay(TODAY) + offsetFromToday);

function input(overrides: Partial<GraphInput> = {}): GraphInput {
  const days = new Map<string, Minutes>([[TODAY, { w: 10, r: 5 }]]);
  return {
    today: TODAY,
    days,
    scale: buildScale([15]),
    center: 0,
    params: DEFAULT_PARAMS,
    ...overrides,
  };
}

describe("計測開始の印 (Issue #80)", () => {
  it("**開始日より前のマスにだけ印が付く**", () => {
    const startDay = day(-30);

    const layout = layoutGraph(input({ startDay }));

    const marked = layout.grid.filter((cell) => cell.beforeStart);
    expect(marked.length).toBeGreaterThan(0);
    expect(marked.every((cell) => cell.day < startDay)).toBe(true);
    expect(layout.grid.filter((cell) => !cell.beforeStart).every((c) => c.day >= startDay)).toBe(
      true,
    );
  });

  it("**開始日そのものには付かない** (その日から計測している)", () => {
    const startDay = day(-30);

    const layout = layoutGraph(input({ startDay }));

    expect(layout.grid.find((cell) => cell.day === startDay)?.beforeStart).toBe(false);
  });

  it("**開始日が表示範囲より前なら 1 つも付かない** (全マスが計測済み)", () => {
    const layout = layoutGraph(input({ startDay: day(-DAYS * MAX_WEEKS) }));

    expect(layout.grid.some((cell) => cell.beforeStart)).toBe(false);
  });

  it("**範囲の最初の日が開始日でも付かない**", () => {
    const layout = layoutGraph(input({ startDay: RANGE_START }));

    expect(layout.grid.some((cell) => cell.beforeStart)).toBe(false);
  });

  it("**記録が 1 日も無ければ印を出さない** (開始日が無い)", () => {
    const layout = layoutGraph(input({ days: new Map() }));

    expect(layout.grid.some((cell) => cell.beforeStart)).toBe(false);
    expect(layout.labels.map((l) => l.text)).not.toContain(START_NOTE);
  });

  it("**印があるときだけ注記を出す**", () => {
    const withMark = layoutGraph(input({ startDay: day(-30) }));
    const withoutMark = layoutGraph(input({ startDay: RANGE_START }));

    expect(withMark.labels.map((l) => l.text)).toContain(START_NOTE);
    expect(withoutMark.labels.map((l) => l.text)).not.toContain(START_NOTE);
  });

  it("**寸法は変わらない** (注記は凡例の行の空きに置く)", () => {
    const withMark = layoutGraph(input({ startDay: day(-30) }));
    const withoutMark = layoutGraph(input());

    expect(withMark.width).toBe(withoutMark.width);
    expect(withMark.height).toBe(withoutMark.height);
  });

  it("枠の色はテーマで変える", () => {
    const light = layoutGraph(input());
    const dark = layoutGraph(input({ params: { ...DEFAULT_PARAMS, theme: "dark" } }));

    expect(light.mutedColor).not.toBe(dark.mutedColor);
  });
});

describe("プロジェクト名 (Issue #119)", () => {
  it("**渡されたときだけ出す**", () => {
    expect(layoutGraph(input()).labels.map((l) => l.text)).not.toContain("villagepump");
    expect(layoutGraph(input({ label: "villagepump" })).labels.map((l) => l.text)).toContain(
      "villagepump",
    );
  });

  it("**太字にする。ほかのラベルは太字にしない** (下端の小さい文字なので、名前だけ立たせる)", () => {
    const layout = layoutGraph(input({ label: "villagepump" }));

    const bold = layout.labels.filter((l) => l.weight === "bold");
    expect(bold.map((l) => l.text)).toEqual(["villagepump"]);
  });

  it("**寸法を変えない** (UserScript が `<img>` に固定寸法を指定しているため)", () => {
    const withLabel = layoutGraph(input({ label: "a-very-long-project-name-here" }));
    const without = layoutGraph(input());

    expect(withLabel.width).toBe(without.width);
    expect(withLabel.height).toBe(without.height);
  });

  it("**計測開始の注記と並べる。名前が先で、重ならない**", () => {
    const layout = layoutGraph(input({ label: "villagepump", startDay: day(-30) }));

    const name = layout.labels.find((l) => l.text === "villagepump");
    const note = layout.labels.find((l) => l.text === START_NOTE);
    expect(name).toBeDefined();
    expect(note).toBeDefined();
    // 同じ行に、名前 → 注記の順で左から並ぶ
    expect(name?.y).toBe(note?.y);
    expect(note?.x ?? 0).toBeGreaterThan(name?.x ?? 0);
  });

  it("名前だけのときは注記の位置に出る (注記が無くても左端から始まる)", () => {
    const onlyName = layoutGraph(input({ label: "villagepump" }));
    const onlyNote = layoutGraph(input({ startDay: day(-30) }));

    const name = onlyName.labels.find((l) => l.text === "villagepump");
    const note = onlyNote.labels.find((l) => l.text === START_NOTE);
    expect(name?.x).toBe(note?.x);
    expect(name?.y).toBe(note?.y);
  });
});
