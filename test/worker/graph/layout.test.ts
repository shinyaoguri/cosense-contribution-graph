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
