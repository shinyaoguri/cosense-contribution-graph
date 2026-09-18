import { describe, expect, it } from "vitest";
import { fromEpochDay, toEpochDay } from "../../../src/shared/epoch-day.ts";
import type { Minutes } from "../../../src/worker/graph/balance.ts";
import { DAYS, DEFAULT_PARAMS, MAX_WEEKS } from "../../../src/worker/graph/grid.ts";
import { type GraphInput, layoutGraph } from "../../../src/worker/graph/layout.ts";
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
  });

  it("**印の意味は文字で説明しない** (2026-09-18。点線の枠だけで活動ゼロと区別が付く)", () => {
    const layout = layoutGraph(input({ startDay: day(-30) }));

    expect(layout.grid.some((cell) => cell.beforeStart)).toBe(true);
    expect(layout.labels.map((l) => l.text).join("")).not.toContain("計測開始");
  });

  it("**寸法は変わらない** (印を出しても出さなくても)", () => {
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
  it("**渡されたときだけ出す。`scrapbox.io/` を前に付けて、行き先が読めるようにする**", () => {
    expect(layoutGraph(input()).labels.map((l) => l.text)).not.toContain("scrapbox.io/villagepump");
    expect(layoutGraph(input({ label: "villagepump" })).labels.map((l) => l.text)).toContain(
      "scrapbox.io/villagepump",
    );
  });

  it("**太字にする。ほかのラベルは太字にしない** (下端の小さい文字なので、名前だけ立たせる)", () => {
    const layout = layoutGraph(input({ label: "villagepump" }));

    const bold = layout.labels.filter((l) => l.weight === "bold");
    expect(bold.map((l) => l.text)).toEqual(["scrapbox.io/villagepump"]);
  });

  it("**寸法を変えない** (UserScript が `<img>` に固定寸法を指定しているため)", () => {
    const withLabel = layoutGraph(input({ label: "a-very-long-project-name-here" }));
    const without = layoutGraph(input());

    expect(withLabel.width).toBe(without.width);
    expect(withLabel.height).toBe(without.height);
  });

  it("**プロジェクトへのリンクを持たせる** (`<img>` では押せないが、画像を開けば飛べる)", () => {
    const layout = layoutGraph(input({ label: "villagepump" }));

    const line = layout.labels.find((l) => l.href !== undefined);
    expect(line?.href).toBe("https://scrapbox.io/villagepump");
    expect(line?.text).toBe("scrapbox.io/villagepump");
  });

  it("**名前が無ければリンクも出さない**", () => {
    expect(layoutGraph(input()).labels.some((l) => l.href !== undefined)).toBe(false);
  });

  it("計測開始の印があっても、出る位置は変わらない", () => {
    const withMark = layoutGraph(input({ label: "villagepump", startDay: day(-30) }));
    const without = layoutGraph(input({ label: "villagepump" }));

    const a = withMark.labels.find((l) => l.href !== undefined);
    const b = without.labels.find((l) => l.href !== undefined);
    expect(a?.x).toBe(b?.x);
    expect(a?.y).toBe(b?.y);
  });
});
