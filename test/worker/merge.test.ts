import { describe, expect, it } from "vitest";
import type { Entry } from "../../src/shared/beacon.ts";
import {
  andNotBits,
  type Bitmap,
  bitmapOf,
  bitsEqual,
  orBits,
  popcount,
} from "../../src/shared/bits.ts";
import { mergeEntry } from "../../src/worker/merge.ts";

function entry(w: number[], r: number[], pages = 0, created = 0): Entry {
  return { ph: "*", day: "2026-09-14", wbits: bitmapOf(w), rbits: bitmapOf(r), pages, created };
}

describe("mergeEntry", () => {
  it("保存済みが無ければ、受け取った値がそのまま集計値になる。r は r & ~w", () => {
    const merged = mergeEntry(entry([1, 2], [2, 3, 4], 5, 1), undefined, undefined);

    expect(merged.bitsChanged).toBe(true);
    expect(merged.dailyChanged).toBe(true);
    expect(merged.daily).toEqual({ w: 2, r: 2, pages: 5, created: 1 });
  });

  it("保存済みと OR し、増えなければ変化なし", () => {
    const stored = { wbits: bitmapOf([1, 2]), rbits: bitmapOf([3]) };
    const daily = { w: 2, r: 1, pages: 1, created: 0 };

    const same = mergeEntry(entry([1], [3], 1), stored, daily);
    expect(same.bitsChanged).toBe(false);
    expect(same.dailyChanged).toBe(false);

    const more = mergeEntry(entry([7], []), stored, daily);
    expect(more.bitsChanged).toBe(true);
    expect(bitsEqual(more.bits.wbits, bitmapOf([1, 2, 7]))).toBe(true);
    expect(more.daily).toEqual({ w: 3, r: 1, pages: 1, created: 0 });
  });

  it("**読みだった分が書きになると r が減る** (独立に max を取ると w + r が 1 分多くなる)", () => {
    const stored = { wbits: bitmapOf([]), rbits: bitmapOf([10]) };
    const merged = mergeEntry(entry([10], []), stored, { w: 0, r: 1, pages: 0, created: 0 });

    expect(merged.daily).toMatchObject({ w: 1, r: 0 });
    expect(merged.dailyChanged).toBe(true);
  });

  it("**ビットマップが無い日は、w も合計も減らさない**", () => {
    const merged = mergeEntry(entry([1], [2]), undefined, { w: 10, r: 5, pages: 3, created: 1 });

    expect(merged.bitsChanged).toBe(true);
    expect(merged.daily).toEqual({ w: 10, r: 5, pages: 3, created: 1 });
    expect(merged.dailyChanged).toBe(false);
  });

  it("pages / created は max", () => {
    const stored = { wbits: bitmapOf([1]), rbits: bitmapOf([]) };
    const daily = { w: 1, r: 0, pages: 4, created: 2 };

    expect(mergeEntry(entry([1], [], 3, 3), stored, daily).daily).toMatchObject({
      pages: 4,
      created: 3,
    });
  });

  it("**どんな順で届いても、ビットマップがある限り集計値は和集合の値と一致する**", () => {
    // 決定論的な擬似乱数 (mulberry32)
    let seed = 42;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
    };
    const randomMinutes = () =>
      Array.from({ length: 20 }, () => Math.floor(random() * 60)).filter((_, i) => i % 2 === 0);

    for (let trial = 0; trial < 200; trial++) {
      const sends = Array.from({ length: 5 }, () => entry(randomMinutes(), randomMinutes()));
      let stored: { wbits: Bitmap; rbits: Bitmap } | undefined;
      let daily: { w: number; r: number; pages: number; created: number } | undefined;
      let unionW = bitmapOf([]);
      let unionR = bitmapOf([]);

      for (const send of sends) {
        const merged = mergeEntry(send, stored, daily);
        stored = merged.bits;
        daily = merged.daily;
        unionW = orBits(unionW, send.wbits);
        unionR = orBits(unionR, send.rbits);

        const w = popcount(unionW);
        expect(daily).toMatchObject({ w, r: popcount(andNotBits(unionR, unionW)) });
      }
    }
  });
});
