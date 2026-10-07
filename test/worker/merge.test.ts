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
import { type DailyValues, mergeEntry } from "../../src/worker/merge.ts";
import type { SegmentCounts } from "../../src/worker/segments.ts";

function entry(
  w: number[],
  r: number[],
  pages = 0,
  created = 0,
  counts: Partial<Pick<Entry, "wc" | "wo" | "links">> = {},
): Entry {
  return {
    ph: "*",
    day: "2026-09-14",
    wbits: bitmapOf(w),
    rbits: bitmapOf(r),
    pages,
    created,
    wc: 0,
    wo: 0,
    links: 0,
    ...counts,
  };
}

/** 作る・関わる・リンクは 0 で、時間帯の内訳は無い (NULL) 集計値。 */
function dailyOf(
  values: Pick<DailyValues, "w" | "r" | "pages" | "created"> & Partial<DailyValues>,
): DailyValues {
  return { wc: 0, wo: 0, links: 0, segments: null, ...values };
}

/** 0–9 の区間だけに活動した日の内訳。 */
function earlyOnly(w: number, r: number): SegmentCounts {
  return { w: [w, 0, 0, 0], r: [r, 0, 0, 0] };
}

const at = (hour: number, minute: number) => hour * 60 + minute;

describe("mergeEntry", () => {
  it("保存済みが無ければ、受け取った値がそのまま集計値になる。r は r & ~w", () => {
    const merged = mergeEntry(entry([1, 2], [2, 3, 4], 5, 1), undefined, undefined);

    expect(merged.bitsChanged).toBe(true);
    expect(merged.dailyChanged).toBe(true);
    expect(merged.daily).toEqual(
      dailyOf({ w: 2, r: 2, pages: 5, created: 1, segments: earlyOnly(2, 2) }),
    );
  });

  it("保存済みと OR し、増えなければ変化なし", () => {
    const stored = { wbits: bitmapOf([1, 2]), rbits: bitmapOf([3]) };
    const daily = dailyOf({ w: 2, r: 1, pages: 1, created: 0, segments: earlyOnly(2, 1) });

    const same = mergeEntry(entry([1], [3], 1), stored, daily);
    expect(same.bitsChanged).toBe(false);
    expect(same.dailyChanged).toBe(false);

    const more = mergeEntry(entry([7], []), stored, daily);
    expect(more.bitsChanged).toBe(true);
    expect(bitsEqual(more.bits.wbits, bitmapOf([1, 2, 7]))).toBe(true);
    expect(more.daily).toEqual(
      dailyOf({ w: 3, r: 1, pages: 1, created: 0, segments: earlyOnly(3, 1) }),
    );
  });

  it("**読みだった分が書きになると r が減る** (独立に max を取ると w + r が 1 分多くなる)", () => {
    const stored = { wbits: bitmapOf([]), rbits: bitmapOf([10]) };
    const merged = mergeEntry(
      entry([10], []),
      stored,
      dailyOf({ w: 0, r: 1, pages: 0, created: 0 }),
    );

    expect(merged.daily).toMatchObject({ w: 1, r: 0 });
    expect(merged.dailyChanged).toBe(true);
  });

  it("**ビットマップが無い日は、w も合計も減らさない**", () => {
    const before = dailyOf({ w: 10, r: 5, pages: 3, created: 1, segments: earlyOnly(10, 5) });
    const merged = mergeEntry(entry([1], [2]), undefined, before);

    expect(merged.bitsChanged).toBe(true);
    expect(merged.daily).toEqual(before);
    expect(merged.dailyChanged).toBe(false);
  });

  it("wc / wo / links も max で、増えただけでも変化あり", () => {
    const stored = { wbits: bitmapOf([1, 2, 3]), rbits: bitmapOf([]) };
    const before: DailyValues = {
      w: 3,
      r: 0,
      pages: 0,
      created: 0,
      wc: 2,
      wo: 0,
      links: 5,
      segments: earlyOnly(3, 0),
    };

    const merged = mergeEntry(
      entry([1, 2, 3], [], 0, 0, { wc: 1, wo: 1, links: 3 }),
      stored,
      before,
    );
    expect(merged.daily).toMatchObject({ wc: 2, wo: 1, links: 5 });
    expect(merged.dailyChanged).toBe(true);

    const same = mergeEntry(entry([1, 2, 3], [], 0, 0, { wc: 2, links: 5 }), stored, before);
    expect(same.dailyChanged).toBe(false);
  });

  it("pages / created は max", () => {
    const stored = { wbits: bitmapOf([1]), rbits: bitmapOf([]) };
    const daily = dailyOf({ w: 1, r: 0, pages: 4, created: 2 });

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
      let values: DailyValues | undefined;
      let unionW = bitmapOf([]);
      let unionR = bitmapOf([]);

      for (const send of sends) {
        const merged = mergeEntry(send, stored, values);
        stored = merged.bits;
        values = merged.daily;
        unionW = orBits(unionW, send.wbits);
        unionR = orBits(unionR, send.rbits);

        const w = popcount(unionW);
        const r = popcount(andNotBits(unionR, unionW));
        expect(values).toMatchObject({ w, r });
        const sum = (quad: readonly number[]) => quad.reduce((a, b) => a + b, 0);
        expect(values?.segments && [sum(values.segments.w), sum(values.segments.r)]).toEqual([
          w,
          r,
        ]);
      }
    }
  });
});

describe("mergeEntry — 時間帯の区間", () => {
  it("**2 回目のビーコンで OR され、区間の値も増える**", () => {
    const first = mergeEntry(entry([at(10, 0)], [at(20, 0)]), undefined, undefined);
    expect(first.daily.segments).toEqual({ w: [0, 1, 0, 0], r: [0, 0, 0, 1] });

    const second = mergeEntry(entry([at(14, 0)], [at(8, 0)]), first.bits, first.daily);
    expect(second.dailyChanged).toBe(true);
    expect(second.daily.segments).toEqual({ w: [0, 1, 1, 0], r: [1, 0, 0, 1] });
  });

  it("**区間ごとに w と合計を max で守る。** 保存済みより小さくならない", () => {
    // ビットマップが無い日に、保存済みより少ない活動のビーコンが来た (受け付ける窓の外では起きうる)
    const before = dailyOf({
      w: 5,
      r: 3,
      pages: 0,
      created: 0,
      segments: { w: [2, 3, 0, 0], r: [1, 0, 2, 0] },
    });
    const merged = mergeEntry(
      entry([at(9, 0)], [at(13, 0), at(13, 1), at(13, 2), at(18, 0)]),
      undefined,
      before,
    );

    // 区間 1 は w 3 を守り、区間 2 は合計 3 が保存済みの 2 を超え、区間 3 は新しく増える
    expect(merged.daily.segments).toEqual({ w: [2, 3, 0, 0], r: [1, 0, 3, 1] });
    expect(merged.dailyChanged).toBe(true);
  });

  it("**読みだった分が書きになると、その区間の r が減り合計は増えない**", () => {
    const stored = { wbits: bitmapOf([]), rbits: bitmapOf([at(10, 0)]) };
    const before = dailyOf({
      w: 0,
      r: 1,
      pages: 0,
      created: 0,
      segments: { w: [0, 0, 0, 0], r: [0, 1, 0, 0] },
    });
    const merged = mergeEntry(entry([at(10, 0)], []), stored, before);

    expect(merged.daily.segments).toEqual({ w: [0, 1, 0, 0], r: [0, 0, 0, 0] });
  });

  it("**保存済みが NULL (内訳なし) なら、max を取らずに新しい値で埋め、変化ありにする**", () => {
    const stored = { wbits: bitmapOf([at(19, 0)]), rbits: bitmapOf([]) };
    // ほかの値はすべて保存済みと同じ。内訳だけが無い
    const before = dailyOf({ w: 1, r: 0, pages: 0, created: 0 });
    const merged = mergeEntry(entry([at(19, 0)], []), stored, before);

    expect(merged.bitsChanged).toBe(false);
    expect(merged.dailyChanged).toBe(true);
    expect(merged.daily.segments).toEqual({ w: [0, 0, 0, 1], r: [0, 0, 0, 0] });
  });

  it("内訳が保存済みと同じなら変化なし", () => {
    const stored = { wbits: bitmapOf([at(19, 0)]), rbits: bitmapOf([]) };
    const before = dailyOf({
      w: 1,
      r: 0,
      pages: 0,
      created: 0,
      segments: { w: [0, 0, 0, 1], r: [0, 0, 0, 0] },
    });

    expect(mergeEntry(entry([at(19, 0)], []), stored, before).dailyChanged).toBe(false);
  });
});
