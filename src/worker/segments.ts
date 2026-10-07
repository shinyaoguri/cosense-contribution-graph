/**
 * 1 日を時間帯の 4 区間に分けて分を数える (Issue #208)。D1 を知らない純関数。
 *
 * **区間は暦の日 (クライアントのローカル日付) の中で切る**: [0:00, 9:00) [9:00, 13:00) [13:00, 18:00) [18:00, 24:00)。
 * 夜 (18–9) は日をまたぐが、描画するときに「D の区間 3 + D+1 の区間 0」として組む。こうすると受け口は
 * 受け取った日の行だけを書けばよい。
 *
 * ビットの位置は `bitmapOf` (`src/shared/bits.ts`) の定義に任せる。区間の外の分を立てたマスクを作り、
 * `a & ~mask` の popcount で数える。
 */
import { andNotBits, type Bitmap, bitmapOf, MINUTES_PER_DAY, popcount } from "../shared/bits.ts";

/** 区間ごとの分の数。添字は区間 (0: 0–9 / 1: 9–13 / 2: 13–18 / 3: 18–24)。 */
export type Quad = readonly [number, number, number, number];

export type SegmentCounts = {
  /** 書いた分 (`popcount(w)` の区間ごとの内訳) */
  readonly w: Quad;
  /** 読んだだけの分 (`popcount(r & ~w)` の区間ごとの内訳) */
  readonly r: Quad;
};

/** 区間ごとに値を作って `Quad` にする。 */
export function quadOf(value: (k: 0 | 1 | 2 | 3) => number): Quad {
  return [value(0), value(1), value(2), value(3)];
}

/** `[start, end)` 分の外の分を立てたマスク。 */
function outside(start: number, end: number): Bitmap {
  return bitmapOf(
    Array.from({ length: MINUTES_PER_DAY }, (_, m) => m).filter((m) => m < start || m >= end),
  );
}

/** 区間ごとのマスク。**境界は 9:00 = 540、13:00 = 780、18:00 = 1080 分** で、境界の分は後ろの区間に入る。 */
const OUTSIDE = [
  outside(0, 540),
  outside(540, 780),
  outside(780, 1080),
  outside(1080, MINUTES_PER_DAY),
] as const;

function countBySegment(bitmap: Bitmap): Quad {
  return quadOf((k) => popcount(andNotBits(bitmap, OUTSIDE[k])));
}

/**
 * 区間ごとの w と r を数える。**同じ分に両方あれば write を優先する** (daily の r と同じ `r & ~w`)。
 * 区間の和は daily の w / r (マージした後のビットマップから数えた値) に一致する。
 */
export function segmentCounts(wbits: Bitmap, rbits: Bitmap): SegmentCounts {
  return { w: countBySegment(wbits), r: countBySegment(andNotBits(rbits, wbits)) };
}
