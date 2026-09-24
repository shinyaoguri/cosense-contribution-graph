/**
 * 日ごとの集計値の JSON `/v1/g/{publicId}/{dataKey}.json` (design §6、ADR-0020)。
 *
 * - `publicId` を `graphs` で引いて `(uid, ph)` を得て、`dataKey` を計算し直して比べる。**表も状態も持たない**
 * - **`graphs` に無いのと鍵が違うのを区別しない** (どちらも `undefined` で 404)。鍵を持たない人に返す情報を増やさない
 * - 全期間を日付の昇順で返す。絵のパラメータ (`weeks` や `year`) は受けない
 */

import { dataKeyOf, PH_ALL } from "../shared/ids.ts";

type DailyRow = {
  readonly day: string;
  readonly w: number;
  readonly r: number;
  readonly pages: number;
  readonly created: number;
};

export type GraphData = {
  /** 合算 (`ph = '*'`) か。uid も ph も出さない */
  readonly total: boolean;
  readonly days: readonly DailyRow[];
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
    .prepare("SELECT day, w, r, pages, created FROM daily WHERE uid = ? AND ph = ? ORDER BY day")
    .bind(graph.uid, graph.ph)
    .all<DailyRow>();
  return {
    total: graph.ph === PH_ALL,
    // 列の順と名前を固定する (D1 の行オブジェクトをそのまま出さない)
    days: results.map(({ day, w, r, pages, created }) => ({ day, w, r, pages, created })),
  };
}

/** 鍵を定数時間で比べる。形は呼ぶ側が `isValidDataKey` で確かめてある (同じ長さ)。 */
function sameKey(expected: string, actual: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(expected);
  const b = encoder.encode(actual);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}
