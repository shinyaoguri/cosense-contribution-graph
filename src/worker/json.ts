/**
 * 日ごとの集計値の JSON `/v1/g/{publicId}/{dataKey}.json` (design §6、ADR-0020)。
 *
 * - `publicId` を `graphs` で引いて `(uid, ph)` を得て、`dataKey` を計算し直して比べる。**表も状態も持たない**
 * - **`graphs` に無いのと鍵が違うのを区別しない** (どちらも `undefined` で 404)。鍵を持たない人に返す情報を増やさない
 * - 全期間を日付の昇順で返す。絵のパラメータ (`weeks` や `year`) は受けない
 * - **時間帯は図と同じ 1 日 3 分割** (朝 9–13 / 昼 13–18 / 夜 18–翌 9) の `slots` で出す。保存の 4 区間は出さない (#228)
 * - 行の無い日でも、翌日の 0–9 時に分があれば 値が 0 で `slots` だけを持つ日として出す (#230)
 */

import { fromEpochDay, toEpochDay } from "../shared/epoch-day.ts";
import { dataKeyOf, PH_ALL } from "../shared/ids.ts";
import { type Slots, slotsOf } from "./graph/grass.ts";
import { type GrassRow, grassDayOf } from "./graph-data.ts";

type DailyRow = {
  readonly day: string;
  readonly w: number;
  readonly r: number;
  readonly pages: number;
  readonly created: number;
  /** 作る (分)。ADR-0021 */
  readonly wc: number;
  /** 関わる (分) */
  readonly wo: number;
  /** 作ったリンクの件数 */
  readonly links: number;
};

type DailyData = DailyRow & {
  /** 朝・昼・夜の分。**夜は D の 18–24 時 + D+1 の 0–9 時** (ADR-0024 決定 1)。内訳なしの日は無い */
  readonly slots?: Slots;
};

export type GraphData = {
  /** 合算 (`ph = '*'`) か。uid も ph も出さない */
  readonly total: boolean;
  readonly days: readonly DailyData[];
};

/** D1 の記録から JSON の本文を作る。`publicId` が無いか鍵が違えば `undefined`。D1 の失敗は throw する。 */
export async function loadGraphData(
  db: D1Database,
  publicId: string,
  dataKey: string,
): Promise<GraphData | undefined> {
  const graph = await db
    .prepare("SELECT uid, ph FROM graphs WHERE public_id = ?")
    .bind(publicId)
    .first<{ uid: string; ph: string }>();
  if (!graph || !sameKey(await dataKeyOf(graph.uid, graph.ph), dataKey)) {
    return undefined;
  }

  // 主キー (uid, ph, day) の前方一致なので、並べ替えは索引の順で済む
  const { results } = await db
    .prepare(
      "SELECT day, w, r, pages, created, wc, wo, links, sw0, sw1, sw2, sw3, sr0, sr1, sr2, sr3 FROM daily WHERE uid = ? AND ph = ? ORDER BY day",
    )
    .bind(graph.uid, graph.ph)
    .all<DailyRow & GrassRow>();
  const grassDays = new Map(results.map((row) => [row.day, grassDayOf(row)]));
  // JSON は「今日」を持たない。翌日の行があれば夜に足す (`slotPopulation` と同じ)
  const withSlots = (row: DailyRow): DailyData => {
    const { day, w, r, pages, created, wc, wo, links } = row;
    const slots = slotsOf(grassDays, day, "9999-12-31");
    // 列の順と名前を固定する (D1 の行オブジェクトをそのまま出さない)
    return { day, w, r, pages, created, wc, wo, links, ...(slots === undefined ? {} : { slots }) };
  };
  const days: DailyData[] = [];
  for (const row of results) {
    // 行の無い前日に、この日の 0–9 時が夜として入るなら、値が 0 の日として足す (#230)。昇順は保たれる
    const previous = fromEpochDay(toEpochDay(row.day) - 1);
    if (!grassDays.has(previous)) {
      const empty = withSlots({ ...ZERO_ROW, day: previous });
      if (empty.slots !== undefined) {
        days.push(empty);
      }
    }
    days.push(withSlots(row));
  }
  return { total: graph.ph === PH_ALL, days };
}

/** 行の無い日の値。暦の日の値なので 0 で正しい */
const ZERO_ROW: Omit<DailyRow, "day"> = {
  w: 0,
  r: 0,
  pages: 0,
  created: 0,
  wc: 0,
  wo: 0,
  links: 0,
};

/** 鍵を定数時間で比べる。形は呼ぶ側が `isValidDataKey` で確かめてある (同じ長さ)。 */
function sameKey(expected: string, actual: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(expected);
  const b = encoder.encode(actual);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}
