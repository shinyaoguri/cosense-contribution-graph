import { describe, expect, it } from "vitest";
import { fromEpochDay, toEpochDay } from "../../../src/shared/epoch-day.ts";
import {
  DAYS,
  gridCells,
  MAX_WEEKS,
  monthLabels,
  WEEKDAY_LABELS,
} from "../../../src/worker/graph/grid.ts";

// 草を描くのは Worker だけなので workerd でだけ走る (ADR-0019)。
// 日付が UTC だけで計算されることは test/shared/epoch-day.test.ts が両環境で見ている

describe("格子のマス", () => {
  it(`どの曜日でも 53 週なら 7 × 52 + 1 = 365 マス、${MAX_WEEKS} 列`, () => {
    // 1 週間ぶん今日をずらし、全曜日で確かめる
    for (let offset = 0; offset < DAYS; offset++) {
      const today = fromEpochDay(toEpochDay("2026-09-06") + offset);
      const cells = gridCells(today, MAX_WEEKS);

      expect(cells).toHaveLength(7 * 52 + 1);
      expect(new Set(cells.map((c) => c.column)).size).toBe(MAX_WEEKS);
    }
  });

  it("今日は右端の列で、行は今日の曜日。今日より後のマスは無い", () => {
    const cells = gridCells("2026-09-09", MAX_WEEKS);
    const last = cells.at(-1);

    expect(last).toEqual({ day: "2026-09-09", column: MAX_WEEKS - 1, row: 3 });
    expect(cells.every((c) => c.day <= "2026-09-09")).toBe(true);
  });

  it("開始日は今日の 364 日前で、左端の列は途中から始まる", () => {
    const cells = gridCells("2026-09-09", MAX_WEEKS);

    expect(cells[0]).toEqual({ day: "2025-09-10", column: 0, row: 3 });
  });

  it("weeks を変えるとマス数は 7 × (weeks − 1) + 1", () => {
    expect(gridCells("2026-09-09", 4)).toHaveLength(22);
    expect(gridCells("2026-09-09", 1)).toHaveLength(1);
  });
});

describe("月ラベル", () => {
  const labels = monthLabels(gridCells("2026-09-09", MAX_WEEKS));

  it("固定の配列から日本語で出す", () => {
    expect(labels.map((l) => l.text)).toEqual([
      "9月",
      "10月",
      "11月",
      "12月",
      "1月",
      "2月",
      "3月",
      "4月",
      "5月",
      "6月",
      "7月",
      "8月",
    ]);
  });

  it("隣り合うラベルは 3 列以上離れる", () => {
    for (let i = 1; i < labels.length; i++) {
      expect((labels[i]?.position ?? 0) - (labels[i - 1]?.position ?? 0)).toBeGreaterThanOrEqual(3);
    }
  });

  it("右端から 2 列以内には出さない (SVG の外へはみ出すため)", () => {
    // **2026-11-01 は日曜で、右端の列がちょうど 11 月 1 日から始まる。** 除外が無ければ
    // 「11月」が右端の列に立つ。月の途中から始まる列だと、その列の最初の日は前の月なので
    // ラベルがそもそも立たず、このテストが空振りする (最初に 2026-10-02 で書いて実際に空振りした)
    // 格子は 2025-11-02 から始まるので、**左端には 11 月が正しく立つ。** 文字で見ると取り違えるので位置で見る
    const nearEdge = monthLabels(gridCells("2026-11-01", MAX_WEEKS));

    expect(nearEdge.some((l) => l.position === MAX_WEEKS - 1)).toBe(false);
    expect(nearEdge.every((l) => l.position <= MAX_WEEKS - 3)).toBe(true);
  });
});

describe("曜日ラベル", () => {
  it("日曜始まりで 7 行すべてに出す", () => {
    expect(WEEKDAY_LABELS).toEqual([
      { position: 0, text: "日" },
      { position: 1, text: "月" },
      { position: 2, text: "火" },
      { position: 3, text: "水" },
      { position: 4, text: "木" },
      { position: 5, text: "金" },
      { position: 6, text: "土" },
    ]);
  });
});
