/**
 * 受け取ったエントリを保存済みの値とマージする純関数 (design §5・§6、ADR-0002)。D1 を知らない。
 */
import type { Entry } from "../shared/beacon.ts";
import { andNotBits, type Bitmap, bitsEqual, orBits, popcount } from "../shared/bits.ts";
import { quadOf, type SegmentCounts, segmentCounts } from "./segments.ts";

export type StoredBits = {
  readonly wbits: Bitmap;
  readonly rbits: Bitmap;
};

export type DailyValues = {
  readonly w: number;
  readonly r: number;
  readonly pages: number;
  readonly created: number;
  readonly wc: number;
  readonly wo: number;
  readonly links: number;
  /**
   * 時間帯の区間ごとの w と r (`segments.ts`、Issue #208)。**null は「内訳なし」** で、0 分とは区別する。
   * 列 (sw0..sw3, sr0..sr3) を足す前の行が null になる。8 列はいつもそろって null か、そろって値を持つ
   */
  readonly segments: SegmentCounts | null;
};

export type Merged = {
  readonly bits: StoredBits;
  /** ビットマップを書き換える必要がある (保存済みが無い、または OR で増えた) */
  readonly bitsChanged: boolean;
  /** マージした後は、時間帯の内訳がいつもある */
  readonly daily: DailyValues & { readonly segments: SegmentCounts };
  readonly dailyChanged: boolean;
};

/**
 * OR でマージして集計値を出す。
 *
 * **集計値は w と合計 (w + r) をそれぞれ max で守り、r はその差にする** (2026-09-14 改訂)。
 * design §5 の当初の「w / r を max で更新する」は二重計上になる。`r = popcount(r & ~w)` は OR に対して
 * 単調でなく、読みだった分が後から書きになると r は減るのに、max は古い r を残すため。
 *
 * - 保存済みのビットマップがある日は、マージした値は保存済みの集合を含むので、w も合計も既存以上になる。
 *   このとき max はマージした値そのもの
 * - ビットマップが無い日 (Cron で消えた後など) に古いビーコンが来ても、w も合計も減らない。
 *   受け付ける窓 (30 日) が保持日数 (90 日) より短いので、受け付けた日には普通は起きない
 * - pages / created / wc / wo / links は数なので max。wc + wo は w を超えうる (端末をまたぐため。design §4)
 * - **時間帯の区間も、区間ごとに w と合計を max で守る** (`mergeSegments`)
 */
export function mergeEntry(
  entry: Entry,
  stored: StoredBits | undefined,
  daily: DailyValues | undefined,
): Merged {
  const wbits = stored ? orBits(stored.wbits, entry.wbits) : entry.wbits;
  const rbits = stored ? orBits(stored.rbits, entry.rbits) : entry.rbits;
  const bitsChanged =
    stored === undefined || !bitsEqual(wbits, stored.wbits) || !bitsEqual(rbits, stored.rbits);

  const w = popcount(wbits);
  // 同じ分に両方あれば write を優先する
  const total = w + popcount(andNotBits(rbits, wbits));

  const mergedW = Math.max(daily?.w ?? 0, w);
  const mergedTotal = Math.max((daily?.w ?? 0) + (daily?.r ?? 0), total);
  const merged: Merged["daily"] = {
    w: mergedW,
    r: mergedTotal - mergedW,
    pages: Math.max(daily?.pages ?? 0, entry.pages),
    created: Math.max(daily?.created ?? 0, entry.created),
    wc: Math.max(daily?.wc ?? 0, entry.wc),
    wo: Math.max(daily?.wo ?? 0, entry.wo),
    links: Math.max(daily?.links ?? 0, entry.links),
    segments: mergeSegments(daily?.segments ?? null, segmentCounts(wbits, rbits)),
  };
  const dailyChanged =
    daily === undefined ||
    merged.w !== daily.w ||
    merged.r !== daily.r ||
    merged.pages !== daily.pages ||
    merged.created !== daily.created ||
    merged.wc !== daily.wc ||
    merged.wo !== daily.wo ||
    merged.links !== daily.links ||
    !segmentsEqual(merged.segments, daily.segments);

  return { bits: { wbits, rbits }, bitsChanged, daily: merged, dailyChanged };
}

/**
 * 区間ごとに、日の w / r と同じ規則で守る: `sw' = max(sw)`、`sr' = max(sw + sr) − sw'`。
 *
 * **保存済みが null (内訳なし) なら max を取らずに新しい値にする。** マージした後のビットマップから数えた値なので、
 * 保存済みのビットマップがある日はそれで正しい。ビットマップが無い日 (受け付ける窓の外。普通は起きない) は、
 * 区間の和が日の w / r より小さくなりうる。区間の値がある日も、ビットマップが無ければ区間ごとの max の和が
 * 日の値とずれうる (日の値の「内訳はずれうる」と同じ。design §5)。
 */
function mergeSegments(stored: SegmentCounts | null, fresh: SegmentCounts): SegmentCounts {
  if (stored === null) {
    return fresh;
  }
  const w = quadOf((k) => Math.max(stored.w[k], fresh.w[k]));
  const r = quadOf((k) => Math.max(stored.w[k] + stored.r[k], fresh.w[k] + fresh.r[k]) - w[k]);
  return { w, r };
}

function segmentsEqual(a: SegmentCounts, b: SegmentCounts | null): boolean {
  return b !== null && a.w.every((v, k) => v === b.w[k]) && a.r.every((v, k) => v === b.r[k]);
}
