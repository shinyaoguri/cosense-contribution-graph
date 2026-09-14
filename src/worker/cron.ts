/**
 * Cron — 90 日より古いビットマップ (daybits) と、期限の切れた登録トークンを消す (design §6、ADR-0013 決定 2)。
 *
 * daily に集計済みなので草は変わらない。`day` にインデックスは無く全行を走査するが、
 * インデックスを足すと書き込みのたびに 1 行余分に数えられる (design §5)。1 日 1 回なので走査を選ぶ。
 */
import { daybitsCutoff } from "./days.ts";

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
