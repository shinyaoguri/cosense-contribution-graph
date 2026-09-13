/**
 * **表で色を指定するスキーム** を作る部品 (design §7)。
 *
 * バランスで列 (読 → 書) を選び、Level で列の中の段を選ぶ。GitHub の草と同じく
 * **色ごとに手で選んだ段階の色** を使うので、どの色も鮮やかなまま濃淡が付く。
 * 色を変えたいだけなら、ここに 16 進の表を渡せば配色が 1 つ増える。
 */
import type { CellInput, ColorScheme, Theme } from "../scheme.ts";

/** Level 1〜4 の色。ライトは淡い → 濃い、ダークは暗い → 明るい (GitHub と同じ向き)。 */
type Ramp = readonly [string, string, string, string];

/** 1 列ぶんの色。 */
type Band = { readonly light: Ramp; readonly dark: Ramp };

export type BandSchemeSpec = {
  readonly name: string;
  /** 列 (読み寄り → 書き寄り)。 */
  readonly bands: readonly Band[];
  /**
   * 列の境界 (昇順、列の数 − 1 個)。**バランスが境界ちょうどなら小さい側 (読み寄り) の列に入れる。**
   * たとえば `[-0.6, -0.2, 0.2, 0.6]` なら -0.6 は 0 列目、-0.59 は 1 列目。
   */
  readonly edges: readonly number[];
  readonly level0: Readonly<Record<Theme, string>>;
  /** 凡例の列ごとのバランスの見本。**それぞれ別の列に入る値を選ぶ。** */
  readonly legendBalances: readonly number[];
};

/** 境界を超えた数が列の番号になる。境界ちょうどは超えていないので小さい側に入る。 */
function columnOf(balance: number, edges: readonly number[]): number {
  return edges.filter((edge) => balance > edge).length;
}

export function bandScheme(spec: BandSchemeSpec): ColorScheme {
  // 表の書き間違いは黙って色を取り違えるので、作るときに落とす
  if (spec.edges.length !== spec.bands.length - 1) {
    throw new RangeError(`${spec.name}: 境界は列の数 − 1 個にする`);
  }
  if (spec.edges.some((edge, i) => i > 0 && edge <= (spec.edges[i - 1] ?? edge))) {
    throw new RangeError(`${spec.name}: 境界は昇順にする`);
  }

  return {
    name: spec.name,
    legendBalances: spec.legendBalances,
    // 合計分数は使わない。手で選んだ色をそのまま使う
    cell({ level, balance }: CellInput, theme: Theme): string {
      if (level === 0) {
        return spec.level0[theme];
      }
      const color = spec.bands[columnOf(balance, spec.edges)]?.[theme][level - 1];
      if (color === undefined) {
        // 作るときに境界の数を確かめているので起きない
        throw new RangeError(`${spec.name}: 色が無い (level=${level}, balance=${balance})`);
      }
      return color;
    },
  };
}
