/**
 * 活動の 4 軸 (作る / 育てる / 関わる / 読む) の集計 (design §4、ADR-0021)。図の形によらない数え方だけを置く。
 *
 * もとは概観 (`overview.ts`) にあったが、概観を廃止して 4 軸を図の線で見せる (ADR-0026) ときに一緒に消えないよう切り出した。
 */

/** 期間の 4 軸の合計 (分)。 */
export type AxisTotals = {
  /** 育てる (自分が前に作ったページに書いた分) */
  readonly grow: number;
  /** 作る (その日に自分が作ったページに書いた分) */
  readonly create: number;
  /** 関わる (他の人が作ったページに書いた分) */
  readonly join: number;
  /** 読む (読んだだけの分) */
  readonly read: number;
};

/** `daily` の 1 日。 */
export type AxisDay = {
  readonly w: number;
  readonly r: number;
  readonly wc: number;
  readonly wo: number;
};

/**
 * 日ごとの値を期間で合計する。**育てるは日ごとに 0 で打ち切ってから足す** (design §4)。
 * 端末をまたぐと `wc` / `wo` を max で守るので、`wc + wo` が `w` を超える日がある。
 */
export function sumAxes(days: Iterable<AxisDay>): AxisTotals {
  let grow = 0;
  let create = 0;
  let join = 0;
  let read = 0;
  for (const day of days) {
    grow += Math.max(0, day.w - day.wc - day.wo);
    create += day.wc;
    join += day.wo;
    read += day.r;
  }
  return { grow, create, join, read };
}

/**
 * 合計が 100 になる整数の % (最大剰余法)。切り捨てた後、端数の大きい順に 1 ずつ足す。
 * **端数が同じなら並びの先を優先する。** 全部 0 なら全部 0。
 *
 * GitHub の丸め方は推定しかできず、四捨五入では合計が 99 や 101 になるので、必ず 100 になる方にした (design §8)。
 */
export function percentages(values: readonly number[]): number[] {
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    return values.map(() => 0);
  }
  const exact = values.map((v) => (v * 100) / sum);
  const result = exact.map(Math.floor);
  const order = exact
    .map((v, i) => ({ i, remainder: v - Math.floor(v) }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  let rest = 100 - result.reduce((a, b) => a + b, 0);
  for (const { i } of order) {
    if (rest === 0) {
      break;
    }
    result[i] = (result[i] ?? 0) + 1;
    rest--;
  }
  return result;
}
