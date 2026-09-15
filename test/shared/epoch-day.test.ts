import { describe, expect, it } from "vitest";
import { fromEpochDay, toEpochDay, weekdayOf } from "../../src/shared/epoch-day.ts";

// 両環境で走る。**jsdom はマシンのタイムゾーンで動く**ので、ここが通ることが
// 「日付を UTC だけで計算している」ことの確認になる

describe("日付 (UTC)", () => {
  it("YYYY-MM-DD と通し日数を往復できる", () => {
    for (const day of ["1970-01-01", "2024-02-29", "2026-09-09", "2026-12-31"]) {
      expect(fromEpochDay(toEpochDay(day))).toBe(day);
    }
  });

  it("曜日はタイムゾーンによらない (2026-09-09 は水曜)", () => {
    expect(weekdayOf(toEpochDay("2026-09-09"))).toBe(3);
    expect(weekdayOf(toEpochDay("2026-09-13"))).toBe(0);
  });

  it("形の違う日付は拒否する", () => {
    expect(() => toEpochDay("2026/09/09")).toThrow(RangeError);
    expect(() => toEpochDay("2026-9-9")).toThrow(RangeError);
  });
});
