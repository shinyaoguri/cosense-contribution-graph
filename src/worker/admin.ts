/**
 * `GET /v1/delete.gif` — その uid のデータを全部消す (design §6「`GET /v1/revoke.gif` と全削除」、
 * privacy.md「データの削除」、段階 8、Issue #79)。
 *
 * 1. **形を見る (400)。** `parsePurgeQuery` が厳密に読む。`confirm=1` が無ければここで落ちる
 * 2. **時刻の窓 (60 秒) を見る (403)**
 * 3. **署名する鍵を `keys` から引き (403)、その鍵で署名を検証する (403)。** ここまで消さない
 * 4. **5 つの表から `uid` の行を 1 回の batch で消す** (batch はトランザクション。`enroll.ts`)
 * 5. 200 と幅 16 (何も無かった) / 17 (消した) の透過 GIF を返す
 *
 * **2 回目は 403 になる。** 鍵も消えるので署名する鍵を引けない。1 回目で消えているので実害は無いが、
 * UserScript は 1 回目の成功でローカルも消すので、押し直す場面がそもそも無い。
 *
 * **`graphs` は `public_id` が主キーで uid にインデックスが無い** (design §5)。消すときは全走査になるが、
 * 全削除は滅多に起きないので索引を足さない (書き込みのたびのコストの方が効く)。
 */
import {
  PURGE_WINDOW_SECONDS,
  type PurgeError,
  parsePurgeQuery,
  purgeWidth,
} from "../shared/purge.ts";
import { verify } from "../shared/sign.ts";
import type { ResolveKey } from "./keys.ts";
import { gifResponse, plainResponse } from "./responses.ts";

export type PurgeDeps = {
  readonly db: D1Database;
  readonly resolveKey: ResolveKey;
  /** 現在時刻 (ミリ秒)。テストで固定する */
  readonly now: () => number;
};

/** ログに出す結果。値そのもの (uid・kid) は出さない。 */
type Reason =
  | PurgeError
  | "time-window"
  | "unknown-key"
  | "bad-signature"
  | "d1"
  | "deleted"
  | "empty";

/** 消す表。**uid を持つ表をすべて挙げる** (新しい表を足したらここにも足す)。 */
const TABLES = ["daybits", "daily", "graphs", "keys", "enroll_tokens"] as const;

export async function handlePurge(url: URL, deps: PurgeDeps): Promise<Response> {
  const parsed = parsePurgeQuery(url.searchParams);
  if (!parsed.ok) {
    return reject(400, parsed.reason);
  }
  const { purge } = parsed;

  const nowMs = deps.now();
  if (Math.abs(nowMs / 1000 - purge.time) > PURGE_WINDOW_SECONDS) {
    return reject(403, "time-window");
  }

  let key: CryptoKey | undefined;
  try {
    key = await deps.resolveKey(purge.uid, purge.kid);
  } catch {
    return reject(500, "d1");
  }
  if (!key) {
    return reject(403, "unknown-key");
  }
  if (!(await verify(key, purge.signature, purge.signingInput))) {
    return reject(403, "bad-signature");
  }

  let rows: number;
  try {
    // **1 回の batch で消す。** 途中で失敗したら全部戻る (batch はトランザクション)
    const results = await deps.db.batch(
      TABLES.map((table) => deps.db.prepare(`DELETE FROM ${table} WHERE uid = ?`).bind(purge.uid)),
    );
    rows = results.reduce((total, result) => total + result.meta.changes, 0);
  } catch {
    // D1 のエラーには数値コードが無い。種別に依らず 500 にする (research §5)
    return reject(500, "d1");
  }

  // 消した行数はログに出す (どの uid かは出さない)
  log(200, rows > 0 ? "deleted" : "empty", rows);
  return gifResponse(purgeWidth({ deleted: rows > 0 }));
}

function reject(status: 400 | 403 | 500, reason: Reason): Response {
  log(status, reason);
  return plainResponse(status);
}

/** Workers Logs に 1 行。**uid・kid は出さない** (ADR-0013 決定 1)。 */
function log(status: number, reason: Reason, rows?: number): void {
  console.log(
    JSON.stringify({ event: "delete", status, reason, ...(rows === undefined ? {} : { rows }) }),
  );
}
