/**
 * Cron — 90 日より古いビットマップ (daybits) と、期限の切れた登録トークンを消す (design §6、ADR-0013 決定 2)。
 * あわせて、時間帯の区間が無い daily の行を daybits から遡って埋める (Issue #208)。
 *
 * daily に集計済みなので草は変わらない。`day` にインデックスは無く全行を走査するが、
 * インデックスを足すと書き込みのたびに 1 行余分に数えられる (design §5)。1 日 1 回なので走査を選ぶ。
 */
import { daybitsCutoff } from "./days.ts";
import { bitmapFrom } from "./ingest.ts";
import { segmentCounts } from "./segments.ts";

/** 消した行数を返す。 */
export async function deleteOldDaybits(db: D1Database, nowMs: number): Promise<number> {
  const result = await db
    .prepare("DELETE FROM daybits WHERE day < ?")
    .bind(daybitsCutoff(nowMs))
    .run();
  return result.meta.changes;
}

/**
 * 使われずに期限が切れた登録トークンを消す。消した行数を返す。
 * 使われたトークンは `/v1/enroll.gif` がその場で消すので、ここに来るのはサインインを途中でやめた分だけ。
 */
export async function deleteExpiredEnrollTokens(db: D1Database, nowMs: number): Promise<number> {
  const result = await db
    .prepare("DELETE FROM enroll_tokens WHERE expires < ?")
    .bind(Math.floor(nowMs / 1000))
    .run();
  return result.meta.changes;
}

/**
 * 1 回の Cron で区間を埋める行数の上限。
 *
 * **書き込みは 1 行ずつ数えられる** (D1 Free の rows written は 1 日 10 万行。design §11)。500 行はその 0.5% で、
 * 受け口の予算を食わない。文の数は行数に依らず SELECT と UPDATE の 2 本 (Free は 1 invocation 50 クエリまで)。
 * 2026-10 の時点の利用者は作者だけで、daybits の残る 90 日分は 1 回で埋まる見込み。
 */
export const BACKFILL_LIMIT = 500;

/**
 * 時間帯の区間 (`sw0..sr3`) が NULL の daily の行を、同じ (uid, ph, day) の daybits から数えて埋める。埋めた行数を返す。
 *
 * - **daybits の無い行は埋めない。** 90 日より古い日はビットマップが消えていて数えられないので、NULL (内訳なし) のまま
 * - **受け口が先に埋めた行を上書きしない。** UPDATE は `sw0 IS NULL` の行だけに当てる。受け口の値はマージした後の
 *   ビットマップから数えたもので、ここで数える値と同じか新しい
 * - 行ごとの値は JSON 1 つにまとめて `json_each` で展開する。行ごとに UPDATE を分けると上限の 50 クエリに当たり、
 *   値を並べてバインドすると 1 文 100 個の上限に当たるため
 * - rows read は走査した行で数える (research §5)。daybits は 90 日分しかなく、daily は主キーで引くので、毎日の読みは小さい
 *
 * **90 日を過ぎれば対象が無くなる** (0006 を当てた後の行は受け口が埋める)。そのあとはこの関数ごと外してよい。
 */
export async function backfillDailySegments(db: D1Database, limit: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT b.uid, b.ph, b.day, b.wbits, b.rbits FROM daybits AS b
       JOIN daily AS d ON d.uid = b.uid AND d.ph = b.ph AND d.day = b.day
       WHERE d.sw0 IS NULL LIMIT ?`,
    )
    .bind(limit)
    .all<Record<string, unknown>>();
  if (results.length === 0) {
    return 0;
  }

  const rows = results.map((row) => {
    const { w, r } = segmentCounts(bitmapFrom(row.wbits), bitmapFrom(row.rbits));
    return [String(row.uid), String(row.ph), String(row.day), ...w, ...r];
  });
  const value = (i: number) => `json_extract(v.value, '$[${i}]')`;
  const result = await db
    .prepare(
      `UPDATE daily SET
         sw0 = ${value(3)}, sw1 = ${value(4)}, sw2 = ${value(5)}, sw3 = ${value(6)},
         sr0 = ${value(7)}, sr1 = ${value(8)}, sr2 = ${value(9)}, sr3 = ${value(10)}
       FROM json_each(?) AS v
       WHERE daily.uid = ${value(0)} AND daily.ph = ${value(1)} AND daily.day = ${value(2)}
         AND daily.sw0 IS NULL`,
    )
    .bind(JSON.stringify(rows))
    .run();
  return result.meta.changes;
}
