import { describe, expect, it } from "vitest";
import { andNotBits, bitmapOf, popcount } from "../../src/shared/bits.ts";
import { segmentCounts } from "../../src/worker/segments.ts";

const at = (hour: number, minute: number) => hour * 60 + minute;

/** 1 分だけ書いた日の区間の w。 */
const writtenIn = (minute: number) => segmentCounts(bitmapOf([minute]), bitmapOf([])).w;

describe("segmentCounts", () => {
  it.each([
    [at(0, 0), [1, 0, 0, 0]],
    [at(8, 59), [1, 0, 0, 0]],
    [at(9, 0), [0, 1, 0, 0]],
    [at(12, 59), [0, 1, 0, 0]],
    [at(13, 0), [0, 0, 1, 0]],
    [at(17, 59), [0, 0, 1, 0]],
    [at(18, 0), [0, 0, 0, 1]],
    [at(23, 59), [0, 0, 0, 1]],
  ])("**分 %i は境界の内側の区間に入る** (0–9 / 9–13 / 13–18 / 18–24)", (minute, expected) => {
    expect(writtenIn(minute)).toEqual(expected);
  });

  it("読みは r & ~w で数え、同じ分に書きがあれば読みに数えない", () => {
    const counts = segmentCounts(
      bitmapOf([at(9, 0), at(9, 1)]),
      bitmapOf([at(9, 1), at(9, 2), at(20, 0)]),
    );

    expect(counts).toEqual({ w: [0, 2, 0, 0], r: [0, 1, 0, 1] });
  });

  it("**区間の和は daily の w と r (r & ~w) に一致する**", () => {
    // 決定論的に散らした分。境界の前後を必ず含める
    const spread = (step: number, offset: number) =>
      Array.from({ length: 1440 }, (_, m) => m).filter(
        (m) => (m * step + offset) % 7 < 3 || [539, 540, 779, 780, 1079, 1080].includes(m),
      );
    const wbits = bitmapOf(spread(3, 1));
    const rbits = bitmapOf(spread(5, 2));

    const counts = segmentCounts(wbits, rbits);
    const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

    expect(sum(counts.w)).toBe(popcount(wbits));
    expect(sum(counts.r)).toBe(popcount(andNotBits(rbits, wbits)));
  });

  it("活動が無い日は全区間 0", () => {
    expect(segmentCounts(bitmapOf([]), bitmapOf([]))).toEqual({
      w: [0, 0, 0, 0],
      r: [0, 0, 0, 0],
    });
  });
});
