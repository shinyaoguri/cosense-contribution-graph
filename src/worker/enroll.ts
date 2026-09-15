/**
 * `GET /v1/enroll.gif` — デバイスの公開鍵を登録する。
 * `GET /v1/revoke.gif` — 登録したデバイスを失効させる (どちらも design §6)。
 *
 * 1. **形を見る (400)。** `parseEnrollQuery` が厳密に読む
 * 2. **公開鍵を読み込み (400)、その鍵で署名を検証する (403)。** ここまで D1 に触らない
 * 3. 1 回の batch で、トークンが有効なら `keys` と全体用の `graphs` を INSERT し、**トークンを消す**
 * 4. 200 と幅 16 (登録済み) / 17 (新しく登録) の透過 GIF を返す
 *
 * **トークンは、期限切れや uid 違いでも最初に提示された時点で消す。** 残すと uid を変えながら何度でも試せる。
 * 署名が違うときは D1 に触らないので消えない (壊れた鍵で送ってもトークンを燃やさない)。
 *
 * 所有証明の署名は**トークンの盗難を防がない。** URL を見られる立場の者は、自分の鍵に差し替えて署名できる。
 * 守っているのは「登録できた鍵は署名できる」ことと、検証を D1 より前に置く順序 (ADR-0009 の改訂)。
 */
import { encodeBase64url } from "../shared/base64url.ts";
import { ENROLL_TOKEN_BYTES, enrollWidth, parseEnrollQuery } from "../shared/enroll.ts";
import { sha256Hex } from "../shared/hash.ts";
import { isValidUid, kidOf, PH_ALL, publicIdOf } from "../shared/ids.ts";
import {
  parseRevokeQuery,
  REVOKE_WINDOW_SECONDS,
  type RevokeError,
  revokeWidth,
} from "../shared/revoke.ts";
import { importVerifyKey, verify } from "../shared/sign.ts";
import type { ResolveKey } from "./keys.ts";
import { gifResponse, plainResponse } from "./responses.ts";

/** 登録トークンの有効期限 (design §3)。 */
export const ENROLL_TOKEN_TTL_SECONDS = 300;

export type EnrollDeps = {
  readonly db: D1Database;
  /** 現在時刻 (ミリ秒)。テストで固定する */
  readonly now: () => number;
};

/** ログに出す結果。値そのもの (uid・kid・トークン) は出さない。 */
type Reason =
  | "keys"
  | "version"
  | "uid"
  | "key"
  | "token"
  | "signature"
  | "bad-signature"
  | "unknown-token"
  | "expired-token"
  | "uid-mismatch"
  | "d1"
  | "added"
  | "known";

/**
 * 登録トークンを発行する。呼ぶのは `/auth/callback` (ID トークンを検証して uid を導いた後)。
 * **D1 にはトークンの SHA-256 だけを書く。**
 */
export async function issueEnrollToken(
  db: D1Database,
  uid: string,
  nowMs: number,
): Promise<{ token: string; expires: number }> {
  if (!isValidUid(uid)) {
    throw new RangeError("uid の形が違う");
  }
  const token = encodeBase64url(crypto.getRandomValues(new Uint8Array(ENROLL_TOKEN_BYTES)));
  const expires = Math.floor(nowMs / 1000) + ENROLL_TOKEN_TTL_SECONDS;
  await db
    .prepare("INSERT INTO enroll_tokens (token_hash, uid, expires) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), uid, expires)
    .run();
  return { token, expires };
}

export async function handleEnroll(url: URL, deps: EnrollDeps): Promise<Response> {
  const parsed = parseEnrollQuery(url.searchParams);
  if (!parsed.ok) {
    return reject(400, parsed.reason);
  }
  const { enrollment } = parsed;

  let key: CryptoKey;
  try {
    key = await importVerifyKey(enrollment.publicKey);
  } catch {
    // 65 バイトでも曲線上の点でなければ読み込めない
    return reject(400, "key");
  }
  if (!(await verify(key, enrollment.signature, enrollment.signingInput))) {
    return reject(403, "bad-signature");
  }

  const { uid } = enrollment;
  const nowSeconds = Math.floor(deps.now() / 1000);
  const [kid, publicId, tokenHash] = await Promise.all([
    kidOf(enrollment.publicKey),
    publicIdOf(uid, PH_ALL),
    sha256Hex(enrollment.token),
  ]);
  // トークンが有効な (ハッシュ・uid・期限が合う) ときだけ SELECT が 1 行を返し、INSERT される
  const validToken = "FROM enroll_tokens WHERE token_hash = ? AND uid = ? AND expires >= ?";

  let results: D1Result<Record<string, unknown>>[];
  try {
    // **batch はトランザクション。** 途中の文が失敗したらトークンの削除も戻る
    results = await deps.db.batch<Record<string, unknown>>([
      deps.db
        .prepare(
          `INSERT INTO keys (uid, kid, pubkey, created) SELECT ?, ?, ?, ? ${validToken} ON CONFLICT (uid, kid) DO NOTHING`,
        )
        .bind(uid, kid, enrollment.publicKey, nowSeconds, tokenHash, uid, nowSeconds),
      deps.db
        .prepare(
          `INSERT INTO graphs (public_id, uid, ph) SELECT ?, ?, ? ${validToken} ON CONFLICT (public_id) DO NOTHING`,
        )
        .bind(publicId, uid, PH_ALL, tokenHash, uid, nowSeconds),
      deps.db
        .prepare("DELETE FROM enroll_tokens WHERE token_hash = ? RETURNING uid, expires")
        .bind(tokenHash),
    ]);
  } catch {
    // D1 のエラーには数値コードが無い。種別に依らず 500 にする (research §5)
    return reject(500, "d1");
  }

  const consumed = results[2]?.results[0];
  if (consumed === undefined) {
    return reject(403, "unknown-token");
  }
  if (Number(consumed.expires) < nowSeconds) {
    return reject(403, "expired-token");
  }
  if (consumed.uid !== uid) {
    return reject(403, "uid-mismatch");
  }

  const added = results[0]?.meta.changes === 1;
  log(200, added ? "added" : "known");
  return gifResponse(enrollWidth({ added }));
}

export type RevokeDeps = EnrollDeps & {
  readonly resolveKey: ResolveKey;
};

/** ログに出す結果。値そのもの (uid・kid) は出さない。 */
type RevokeReason =
  | RevokeError
  | "time-window"
  | "unknown-key"
  | "bad-signature"
  | "d1"
  | "removed"
  | "absent";

/**
 * デバイスを失効させる。
 *
 * 1. **形を見る (400)。** `parseRevokeQuery` が厳密に読む
 * 2. **時刻の窓 (60 秒) を見る (403)。** 破壊的な操作なので記録より狭い (design §6)
 * 3. **署名する鍵を `keys` から引き (403)、その鍵で署名を検証する (403)。** ここまで書き込まない
 * 4. `keys` の行を消す。**失効は行の削除**で、列は増やさない。登録し直すには ID トークンが要るので、
 *    行が無い状態がそのまま締め出しになる
 * 5. 200 と幅 16 (もう無かった) / 17 (消した) の透過 GIF を返す
 *
 * **消せるのは同じ uid の鍵だけ。** 署名する鍵と消す鍵が同じでもよい (この端末の失効)。
 */
export async function handleRevoke(url: URL, deps: RevokeDeps): Promise<Response> {
  const parsed = parseRevokeQuery(url.searchParams);
  if (!parsed.ok) {
    return rejectRevoke(400, parsed.reason);
  }
  const { revocation } = parsed;

  const nowMs = deps.now();
  if (Math.abs(nowMs / 1000 - revocation.time) > REVOKE_WINDOW_SECONDS) {
    return rejectRevoke(403, "time-window");
  }

  let key: CryptoKey | undefined;
  try {
    key = await deps.resolveKey(revocation.uid, revocation.kid);
  } catch {
    return rejectRevoke(500, "d1");
  }
  if (!key) {
    return rejectRevoke(403, "unknown-key");
  }
  if (!(await verify(key, revocation.signature, revocation.signingInput))) {
    return rejectRevoke(403, "bad-signature");
  }

  let removed: boolean;
  try {
    const result = await deps.db
      .prepare("DELETE FROM keys WHERE uid = ? AND kid = ?")
      .bind(revocation.uid, revocation.target)
      .run();
    removed = result.meta.changes > 0;
  } catch {
    // D1 のエラーには数値コードが無い。種別に依らず 500 にする (research §5)
    return rejectRevoke(500, "d1");
  }

  logRevoke(200, removed ? "removed" : "absent");
  return gifResponse(revokeWidth({ removed }));
}

function rejectRevoke(status: 400 | 403 | 500, reason: RevokeReason): Response {
  logRevoke(status, reason);
  return plainResponse(status);
}

/** Workers Logs に 1 行。**uid・kid は出さない** (ADR-0013 決定 1)。 */
function logRevoke(status: number, reason: RevokeReason): void {
  console.log(JSON.stringify({ event: "revoke", status, reason }));
}

function reject(status: 400 | 403 | 500, reason: Reason): Response {
  log(status, reason);
  return plainResponse(status);
}

/** Workers Logs に 1 行。**uid・kid・トークン・そのハッシュ・IP は出さない** (ADR-0013 決定 1)。 */
function log(status: number, reason: Reason): void {
  console.log(JSON.stringify({ event: "enroll", status, reason }));
}
