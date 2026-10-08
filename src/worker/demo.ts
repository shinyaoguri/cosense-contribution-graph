/**
 * 疎通確認と見た目の確認に使うデモの草 (publicId = `demo`)。実データを持たない。
 *
 * **決定論的に作る。** 乱数を使うと ETag もテストの期待値も毎回変わる。
 */

import { fromEpochDay, toEpochDay, weekdayOf } from "../shared/epoch-day.ts";
import { SPAN_WEEKS } from "../shared/grass.ts";
import type { AxisDay } from "./graph/axes.ts";
import type { Minutes } from "./graph/balance.ts";
import type { GrassDay } from "./graph/grass.ts";
import { type Quad, quadOf } from "./segments.ts";

/**
 * デモの「今日」。**週の途中 (水曜) に固定する。** 日曜や土曜だと左右の列が欠けず、
 * 欠け方の回帰が見えなくなる。
 */
export const DEMO_TODAY = "2026-09-09";

/** 疎通確認と見た目の確認のために予約した publicId。 */
export const DEMO_PUBLIC_ID = "demo";

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
// 数種類の割合だけだと間の列がほとんど出ない (3 種類では 2 列目が 18 日、4 列目が 7 日だった)。
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
  // 直近 53 週ぶん (今日の 7 × 52 日前から)
  const displayStart = today - 7 * (SPAN_WEEKS.year - 1);

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

/**
 * 4 軸のデモ (ADR-0021)。日ごとの分 (`demoData`) から、書いた分の一部を作る・関わるに振り分ける。
 * もとは活動の概観のデモで、今は図の下の線の値になる (ADR-0026)
 */
function demoAxisDays(): ReadonlyMap<string, AxisDay> {
  const result = new Map<string, AxisDay>();
  for (const [day, minutes] of demoData().days) {
    // 草の割合と相関させないよう、別の種から取る
    const h = hash32(toEpochDay(day) ^ 0x5bd1e995);
    const wc = Math.floor((minutes.w * (h % 30)) / 100);
    const wo = Math.floor(((minutes.w - wc) * ((h >>> 8) % 50)) / 100);
    result.set(day, { ...minutes, wc, wo });
  }
  return result;
}

/**
 * カードの図のデモで描く名前 (ADR-0024)。クエリ (`?l=` / `?u=`) があればそちらを描く。
 * **デモは外へアイコンを取りに行かない** (`DEMO_ICON`)
 */
export const DEMO_CARD_LABEL = "cosense-grass";
export const DEMO_CARD_USER = "demo";

/**
 * デモのアイコン (16 × 16 の PNG、133 バイト)。既定の配色の色を 4 × 4 に並べた小さな草。
 * 実在の人のアイコンは使わない
 */
export const DEMO_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAATElEQVR42mNY+uAUHBksaoKj128/wFHxoeVwxDAINZzc+gGOUCRKo+EI2dDBqAFZ0Y352nCEHAD/H22Go8GoATmCkD2HbBCy5kGoAQAlrvXg9+2V7gAAAABJRU5ErkJggg==";

/**
 * **この日より前は内訳なし** (区間の列を足す前の日。ADR-0024 決定 2)。カードの左端の 2 列が薄く塗られ、
 * 本番で古い日がどう見えるかをデモでも確かめられる
 */
const DEMO_SEGMENTS_FROM = "2026-03-30";

/**
 * 区間 (0–9 / 9–13 / 13–18 / 18–24) ごとの重み。平日は日中に書き、夜に読む。休日は夜に寄せる。
 * 区間 0 は前の日の夜に足されるので小さめにする
 */
const SEGMENT_WEIGHTS = {
  weekday: { w: [0.05, 0.4, 0.4, 0.15], r: [0.15, 0.2, 0.25, 0.4] },
  weekend: { w: [0.1, 0.15, 0.3, 0.45], r: [0.2, 0.15, 0.25, 0.4] },
} as const;

/** `total` を重みに揺らぎを掛けて 4 区間に分ける (最大剰余法なので合計は `total` に一致する) */
function splitTotal(total: number, weights: readonly number[], h: number): Quad {
  // 区間ごとに 0.4〜1.6 倍の揺らぎ。h の別のバイトから取る
  const jittered = weights.map(
    (weight, k) => weight * (0.4 + (((h >>> (k * 8)) & 0xff) / 255) * 1.2),
  );
  const sum = jittered.reduce((a, b) => a + b, 0);
  const exact = jittered.map((v) => (total * v) / sum);
  const counts = exact.map(Math.floor);
  const order = exact
    .map((v, k) => ({ k, remainder: v - Math.floor(v) }))
    .sort((a, b) => b.remainder - a.remainder || a.k - b.k);
  let rest = total - counts.reduce((a, b) => a + b, 0);
  for (const { k } of order) {
    if (rest === 0) {
      break;
    }
    counts[k] = (counts[k] ?? 0) + 1;
    rest--;
  }
  return quadOf((k) => counts[k] ?? 0);
}

/**
 * 図のデモ (ADR-0024・0026)。4 軸のデモの日から、書いた分と読んだ分を 4 区間に振り分ける。
 * **元のデモデータ (`demoData` / `demoAxisDays`) は変えない** (ゴールデンテストと ETag を保つ)。
 * 区間の合計はその日の w / r に一致する (本番と同じ)
 */
export function demoCardDays(): ReadonlyMap<string, GrassDay> {
  const result = new Map<string, GrassDay>();
  for (const [day, values] of demoAxisDays()) {
    if (day < DEMO_SEGMENTS_FROM) {
      result.set(day, values);
      continue;
    }
    const epoch = toEpochDay(day);
    const weekday = weekdayOf(epoch);
    const weights =
      weekday === 0 || weekday === 6 ? SEGMENT_WEIGHTS.weekend : SEGMENT_WEIGHTS.weekday;
    // 草と概観の割合と相関させないよう、別の種から取る
    const h = hash32(epoch ^ 0x27d4eb2f);
    result.set(day, {
      ...values,
      segments: {
        w: splitTotal(values.w, weights.w, h),
        r: splitTotal(values.r, weights.r, hash32(h)),
      },
    });
  }
  return result;
}
