import { describe, expect, it } from "vitest";
import { fromEpochDay, toEpochDay } from "../../../src/shared/epoch-day.ts";
import { MAX_PROJECT_NAME_LENGTH } from "../../../src/shared/project-name.ts";
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

  it("**53 週では上限の長さでも寸法を変えない** (UserScript が `<img>` に固定寸法を指定しているため)", () => {
    const withLabel = layoutGraph(input({ label: "a".repeat(MAX_PROJECT_NAME_LENGTH) }));
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

describe("凡例 (Issue #133)", () => {
  /** 太字 9px の数字の実測 (6.4px/字、2026-09-23) を切り上げた見積もり。layout.ts と独立に持つ */
  const PROJECT_CHAR_WIDTH = 6.5;
  /** 凡例の文字は 9px の全角 */
  const CJK_WIDTH = 9;

  it("**53 週の寸法は 775 × 146** (UserScript の `GRAPH_WIDTH` / `GRAPH_HEIGHT` と同じにする)", () => {
    const layout = layoutGraph(input());

    expect(layout.width).toBe(775);
    expect(layout.height).toBe(146);
  });

  it("**凡例は格子の下の 1 行に収まる** (量の 4 マス + 読み書きの 5 マス)", () => {
    const layout = layoutGraph(input());
    const gridBottom = Math.max(...layout.grid.map((cell) => cell.y)) + layout.cellSize;

    expect(layout.legend).toHaveLength(4 + 5);
    expect(new Set(layout.legend.map((swatch) => swatch.y)).size).toBe(1);
    expect(layout.legend[0]?.y).toBeGreaterThan(gridBottom);
    expect(layout.height).toBe((layout.legend[0]?.y ?? 0) + layout.cellSize + 8);
  });

  it("**量の帯は読み寄りの帯より左で、帯どうしのマスは重ならない**", () => {
    const layout = layoutGraph(input());
    const xs = layout.legend.map((swatch) => swatch.x);

    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    for (let i = 1; i < xs.length; i++) {
      expect((xs[i] ?? 0) - (xs[i - 1] ?? 0)).toBeGreaterThanOrEqual(layout.cellSize);
    }
    expect(Math.max(...xs) + layout.cellSize).toBeLessThanOrEqual(layout.width - 8);
  });

  it("**軸の文字は 4 つ** (少ない / 多い / 読む / 書く)", () => {
    const texts = layoutGraph(input()).labels.map((l) => l.text);

    for (const text of ["少ない", "多い", "読む", "書く"]) {
      expect(texts).toContain(text);
    }
  });

  it("**write モードは量の帯だけ** (全マスのバランスが 0 なので読み書きの見本は意味が無い)", () => {
    const layout = layoutGraph(input({ params: { ...DEFAULT_PARAMS, mode: "write" } }));
    const texts = layout.labels.map((l) => l.text);

    expect(layout.legend).toHaveLength(4);
    expect(texts).not.toContain("読む");
    expect(texts).not.toContain("書く");
    expect(layout.height).toBe(146);
  });

  it.each([1, 10, 20, MAX_WEEKS])(
    "**%i 週でも、上限の長さのプロジェクト名と凡例が重ならない**",
    (weeks) => {
      const name = "0".repeat(MAX_PROJECT_NAME_LENGTH);
      const layout = layoutGraph(input({ label: name, params: { ...DEFAULT_PARAMS, weeks } }));
      const project = layout.labels.find((l) => l.href !== undefined);
      const projectEnd = (project?.x ?? 0) + `scrapbox.io/${name}`.length * PROJECT_CHAR_WIDTH;
      // 「少ない」は右揃えで置くので、左端は x − 文字幅
      const low = layout.labels.find((l) => l.text === "少ない");
      const legendStart = (low?.x ?? 0) - "少ない".length * CJK_WIDTH;

      expect(projectEnd).toBeLessThan(legendStart);
    },
  );

  it("**週数が少ないときは、名前のぶんだけ横に広げる** (凡例と重ならないように)", () => {
    const params = { ...DEFAULT_PARAMS, weeks: 1 };
    const without = layoutGraph(input({ params }));
    const withLabel = layoutGraph(input({ params, label: "villagepump" }));

    expect(withLabel.width).toBeGreaterThan(without.width);
  });
});
