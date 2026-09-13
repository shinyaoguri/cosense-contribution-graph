/**
 * 読み書きのバランスを測る (design §7)。**色は決めない** (色はスキームの関心、`scheme.ts`)。
 *
 * 読みと書きの比は典型的に 6 対 1 程度で、素朴な `w / (w + r)` では偏りが全日に出る。
 * 対数オッズを取り、**中心を自分の中央値に置いて** `tanh` で -1 (読) .. +1 (書) に押し込める。
 * `center` も四分位と同じく `ph = '*'` から取る。両 lib で型検査され、両環境でテストされる。
 */
import { MIN_MINUTES, quantile } from "./scale.ts";

/** 1 日の書きの分数 `w` と読みの分数 `r`。`r` は `r & ~w` 済みで、`w + r` が二重計上なしの合計。 */
export type Minutes = {
  readonly w: number;
  readonly r: number;
};

/**
 * 対数オッズの平滑化。少ない分数で比が極端に振れるのを抑える。
 * デッドゾーンの `MIN_MINUTES` と値は同じだが意味が違うので分けてある。**仮値** (design §15 の外)
 */
const ODDS_PRIOR = 3;

/** `tanh` の除数。大きいほど色相の変化が穏やかになる。**仮値** (design §15) */
const TANH_DIVISOR = 1.2;

export function oddsOf(day: Minutes): number {
  return Math.log((day.w + ODDS_PRIOR) / (day.r + ODDS_PRIOR));
}

/**
 * バランスの中心 (対数オッズの中央値)。
 *
 * **外れ値のフェンスをかける前**の母集団 (合計がデッドゾーン以上の日) から取る。
 * design の擬似コードはフェンスをかけていない。母集団が空なら 0 (比 1 対 1 が中心)。
 */
export function centerOf(days: Iterable<Minutes>): number {
  const odds = [...days]
    .filter((d) => d.w + d.r >= MIN_MINUTES)
    .map(oddsOf)
    .sort((a, b) => a - b);
  return odds.length === 0 ? 0 : quantile(odds, 0.5);
}

/** -1 (読み寄り) .. +1 (書き寄り)。 */
export function balanceOf(day: Minutes, center: number): number {
  return Math.tanh((oddsOf(day) - center) / TANH_DIVISOR);
}
