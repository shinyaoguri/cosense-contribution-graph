/**
 * 活動量 (合計分数) を Level 0〜4 に振り分ける四分位スケール (design §7)。
 *
 * **母集団は常に `ph = '*'` の全期間**から取る。プロジェクト別の草もこの共通のスケールで塗る。
 * 両 lib で型検査され、両環境でテストされる。
 */

/**
 * デッドゾーン。合計がこれ未満の日は Level 0 で、**四分位の母集団からも外す。**
 *
 * design §7 は「0 の日を母集団から除外」とだけ書くが、それでは足りない。20 秒ポーリングで
 * 1〜2 分の日は多く出るので、それらを母集団に残すと四分位が小さい値に潰れ、
 * `<=` で防いだはずの「全マス Level 4」が再発する (ADR-0015)。
 *
 * **仮値** (design §15)。段階 7 で実データから決める。
 */
export const MIN_MINUTES = 3;

// 外れ値のフェンスは Q3 + 1.5 × IQR。**仮値** (design §15)
const OUTLIER_IQR_FACTOR = 1.5;

export type Level = 0 | 1 | 2 | 3 | 4;

export type Scale = {
  readonly q1: number;
  readonly q2: number;
  readonly q3: number;
};

/**
 * 昇順に並んだ空でない配列の分位点 (線形補間、type 7)。
 * p = 0.5 のとき、偶数個なら中央 2 つの平均と一致する。
 */
export function quantile(sorted: readonly number[], p: number): number {
  const pos = (sorted.length - 1) * p;
  const lower = Math.floor(pos);
  const a = sorted[lower];
  const b = sorted[Math.ceil(pos)];
  if (a === undefined || b === undefined) {
    throw new RangeError("quantile には空でない配列を渡す");
  }
  return a + (b - a) * (pos - lower);
}

/**
 * 母集団 (合計分数の列) から四分位を作る。
 *
 * - デッドゾーン未満の日を外す
 * - 上側フェンス `Q3 + 1.5 × IQR` で外れ値を落とす。**`<=` で残す。** `<` にすると値が 1 種類に
 *   潰れた母集団 (例 [3,3,3,3]) でフェンスが Q3 と等しくなり、全部落ちて空になる。
 *   `<=` ならフェンス ≥ Q3 ≥ 最小値なので必ず 1 件以上残る
 * - **母集団が空なら四分位を +∞ にする。** 3 分以上の日は Level 1 になり、表示すべきデータが隠れない
 */
export function buildScale(totals: Iterable<number>): Scale {
  const population = [...totals].filter((t) => t >= MIN_MINUTES).sort((a, b) => a - b);
  if (population.length === 0) {
    return {
      q1: Number.POSITIVE_INFINITY,
      q2: Number.POSITIVE_INFINITY,
      q3: Number.POSITIVE_INFINITY,
    };
  }

  const q1 = quantile(population, 0.25);
  const q3 = quantile(population, 0.75);
  const fence = q3 + OUTLIER_IQR_FACTOR * (q3 - q1);
  const kept = population.filter((t) => t <= fence);

  return { q1: quantile(kept, 0.25), q2: quantile(kept, 0.5), q3: quantile(kept, 0.75) };
}

/**
 * 合計分数を Level にする。
 *
 * **比較は `<=`** (design §7)。離散値が少ないと四分位が同値に潰れ、`<` だと全マスが
 * いきなり Level 4 になる。潰れたときに特別な分岐は書かない。`<=` を順に比べれば
 * 自然に Level 1 になり、部分的に潰れたケース (Q1 = Q2 < Q3 など) とも挙動がずれない。
 */
export function levelOf(total: number, scale: Scale): Level {
  if (total < MIN_MINUTES) {
    return 0;
  }
  if (total <= scale.q1) {
    return 1;
  }
  if (total <= scale.q2) {
    return 2;
  }
  if (total <= scale.q3) {
    return 3;
  }
  return 4;
}
