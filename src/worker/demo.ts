/**
 * 疎通確認と見た目の確認に使うデモの草 (publicId = `demo`)。実データを持たない。
 *
 * **決定論的に作る。** 乱数を使うと ETag もテストの期待値も毎回変わる。
 */

import { fromEpochDay, toEpochDay } from "../shared/epoch-day.ts";
import type { Minutes } from "./graph/balance.ts";
import { DAYS, MAX_WEEKS } from "./graph/grid.ts";

/**
 * デモの「今日」。**週の途中 (水曜) に固定する。** 日曜や土曜だと左右の列が欠けず、
 * 欠け方の回帰が見えなくなる。
 */
export const DEMO_TODAY = "2026-09-09";

export type DemoData = {
  /** 表示範囲 (直近 53 週) の日ごとの分数。活動の無い日は入れない。 */
  readonly days: ReadonlyMap<string, Minutes>;
  /** 四分位と中心を取る母集団。**表示範囲より古い 1 年ぶんも含む。** */
  readonly population: readonly Minutes[];
};

/** 整数から 32 bit の擬似乱数を作る (mulberry32 の 1 段)。同じ入力には同じ値を返す。 */
function hash32(n: number): number {
  let t = (n + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

// 書きの割合を**幅を持たせて連続に散らす。** 既定の配色は読み寄りから書き寄りまでを 5 列に分けるので、
// 数種類の割合だけだと間の列がほとんど出ない (3 種類では藍 18 日、赤紫 7 日だった)。
// 3〜85% なら 3 分以上の日が 5 列に 45〜69 日ずつ入る。
// 平日を一律に書き寄りにするような偏りは入れない。中央値 (バランスの中心) が偏りに寄って、
// 端の列が出なくなる
const WRITE_SHARE_MIN = 0.03;
const WRITE_SHARE_MAX = 0.85;

function demoDay(epochDay: number, minTotal: number, spread: number): Minutes | undefined {
  const h = hash32(epochDay);
  const bucket = h % 100;
  if (bucket < 12) {
    return undefined;
  }
  if (bucket < 17) {
    // デッドゾーン未満の日 (1〜2 分)。Level 0 で塗られ、母集団からも外れる
    const total = 1 + ((h >>> 3) % 2);
    return { w: 0, r: total };
  }
  const total = minTotal + ((h >>> 8) % spread);
  // 割合は合計と別のハッシュから取る。同じ h のビットを使うと合計と割合が相関する
  const share = WRITE_SHARE_MIN + (hash32(h) / 2 ** 32) * (WRITE_SHARE_MAX - WRITE_SHARE_MIN);
  const w = Math.round(total * share);
  return { w, r: total - w };
}

export function demoData(): DemoData {
  const today = toEpochDay(DEMO_TODAY);
  const displayStart = today - DAYS * (MAX_WEEKS - 1);

  const days = new Map<string, Minutes>();
  const population: Minutes[] = [];

  for (let day = displayStart; day <= today; day++) {
    const minutes = demoDay(day, 5, 85);
    if (minutes) {
      days.set(fromEpochDay(day), minutes);
      population.push(minutes);
    }
  }

  // **表示範囲より古い日を、分布を変えて母集団だけに入れる。** 描画が表示範囲だけから四分位を
  // 取るバグがあると色が変わるので、テストで検出できる。
  //
  // 差は小さく保つ。古い日を大きくしすぎると四分位が引き上げられ、表示範囲に Level 4 が出ない
  // (60〜179 分にしたら 0 マスだった)。10〜99 分なら表示範囲の Level 1〜4 が 87/79/81/51 マスになる
  for (let day = displayStart - 365; day < displayStart; day++) {
    const minutes = demoDay(day, 10, 90);
    if (minutes) {
      population.push(minutes);
    }
  }

  return { days, population };
}
