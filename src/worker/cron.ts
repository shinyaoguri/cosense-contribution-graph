/**
 * Cron — 90 日より古いビットマップ (daybits) を消す (design §6、ADR-0013 決定 2)。
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
