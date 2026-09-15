/**
 * サインインした人を短時間だけ覚える署名付き cookie (design §3、ADR-0017)。
 * **端末の一覧を見せるためだけ**にあり、記録の送信には一切使わない (送信は端末の鍵の署名。ADR-0009)。
 *
 * ```
 * __Host-grass-session=<base64url(payload)>.<base64url(HMAC)>; Max-Age=1800; Path=/; Secure; HttpOnly; SameSite=Lax
 * payload = ver(1) | issuedAt(u32 BE、unix 秒) | uid(20)   = 25 バイト
 * ```
 *
 * - **`__Host-` と `HttpOnly` と `SameSite=Lax`** (`auth-cookie.ts` と同じ理由)。
 *   JS から読めないので、この cookie から uid が漏れる経路はブラウザの外に無い
 * - **期限はサーバでも見る。** 30 分。端末を管理するには短すぎず、置き忘れた画面が残り続けるには短い
 * - **HMAC の鍵は `WORKER_SECRET` から用途を分けて導く。** サインインの往復の cookie とも別のラベル
 * - **中身は uid そのもの。** 乱数の session id にして D1 で引く形にしない (書き込みの予算を使い、
 *   期限切れの掃除も要る。design §11)。**その代わり失効はできない**ので、期限を短くしている
 */
import { decodeBase64url, encodeBase64url } from "../shared/base64url.ts";
import { isValidUid, UID_BYTES } from "../shared/ids.ts";

export const SESSION_COOKIE_NAME = "__Host-grass-session";

/** サインインしてから端末を管理できる時間 (privacy.md「Cookie」)。 */
export const SESSION_MAX_AGE_SECONDS = 1800;

/** 発行時刻が未来でも許すずれ */
const FUTURE_SKEW_SECONDS = 60;

const COOKIE_VERSION = 1;
const PAYLOAD_BYTES = 1 + 4 + UID_BYTES;
const MAC_BYTES = 32;

/** 鍵を導く用途のラベル。変えても影響は発行済みの cookie (最長 30 分) が無効になるだけ */
const KEY_LABEL = "cosense-grass:session-cookie:v1";

/** CSRF トークンを導く用途のラベル。 */
const CSRF_LABEL = "cosense-grass:session-csrf:v1";

const COOKIE_ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax";

export type Session = {
  /** unix 秒 */
  readonly issuedAt: number;
  readonly uid: string;
};

type OpenError = "missing" | "duplicate" | "format" | "signature" | "expired";

type OpenResult =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly reason: OpenError };

/** `Set-Cookie` の値。 */
export async function sealSession(secret: string, uid: string, nowMs: number): Promise<string> {
  const bytes = decodeBase64url(uid);
  if (bytes?.length !== UID_BYTES) {
    throw new RangeError("uid の形が違う");
  }
  const payload = new Uint8Array(PAYLOAD_BYTES);
  const view = new DataView(payload.buffer);
  view.setUint8(0, COOKIE_VERSION);
  view.setUint32(1, Math.floor(nowMs / 1000));
  payload.set(bytes, 5);
  const mac = await crypto.subtle.sign("HMAC", await sessionKey(secret, "sign"), payload);
  const value = `${encodeBase64url(payload)}.${encodeBase64url(new Uint8Array(mac))}`;
  return `${SESSION_COOKIE_NAME}=${value}; Max-Age=${SESSION_MAX_AGE_SECONDS}; ${COOKIE_ATTRIBUTES}`;
}

/** cookie を消す `Set-Cookie` の値。属性は発行時と揃える */
export function clearSession(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`;
}

/** リクエストの `Cookie` ヘッダから読み、署名と期限を確かめる。 */
export async function openSession(
  secret: string,
  header: string | null,
  nowMs: number,
): Promise<OpenResult> {
  const prefix = `${SESSION_COOKIE_NAME}=`;
  const values = (header ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(prefix))
    .map((pair) => pair.slice(prefix.length));
  if (values.length === 0) {
    return { ok: false, reason: "missing" };
  }
  // 同名が 2 つ届くのは、別の経路で差し込まれたとき (auth-cookie.ts と同じ)
  if (values.length > 1) {
    return { ok: false, reason: "duplicate" };
  }

  const parts = (values[0] ?? "").split(".");
  const payload = parts.length === 2 ? decodeBase64url(parts[0] ?? "") : undefined;
  const mac = parts.length === 2 ? decodeBase64url(parts[1] ?? "") : undefined;
  if (
    payload?.length !== PAYLOAD_BYTES ||
    mac?.length !== MAC_BYTES ||
    payload[0] !== COOKIE_VERSION
  ) {
    return { ok: false, reason: "format" };
  }
  if (!(await crypto.subtle.verify("HMAC", await sessionKey(secret, "verify"), mac, payload))) {
    return { ok: false, reason: "signature" };
  }

  const issuedAt = new DataView(payload.buffer).getUint32(1);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (
    nowSeconds - issuedAt > SESSION_MAX_AGE_SECONDS ||
    issuedAt > nowSeconds + FUTURE_SKEW_SECONDS
  ) {
    return { ok: false, reason: "expired" };
  }
  const uid = encodeBase64url(payload.slice(5));
  if (!isValidUid(uid)) {
    return { ok: false, reason: "format" };
  }
  return { ok: true, session: { issuedAt, uid } };
}

/**
 * フォームに埋める CSRF トークン。**セッションに結び付ける** (ほかの人のトークンは通らない)。
 *
 * `SameSite=Lax` で cookie が別サイトからの POST に付かないので二重の守りだが、
 * cookie の扱いはブラウザによって差があるため、フォーム側でも確かめる。
 */
export function csrfToken(secret: string, session: Session): Promise<string> {
  return derive(secret, CSRF_LABEL, `${session.uid}:${session.issuedAt}`);
}

/** フォームから来たトークンを確かめる。長さが違うものも含めて一定時間で比べる。 */
export async function verifyCsrf(
  secret: string,
  session: Session,
  value: string,
): Promise<boolean> {
  const expected = await csrfToken(secret, session);
  if (expected.length !== value.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ value.charCodeAt(i);
  }
  return diff === 0;
}

/** `HMAC(WORKER_SECRET, KEY_LABEL)` を鍵にする。uid の導出とも往復の cookie とも鍵を分ける */
async function sessionKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  if (secret.length === 0) {
    throw new RangeError("secret は空にできない");
  }
  const encoder = new TextEncoder();
  const root = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign("HMAC", root, encoder.encode(KEY_LABEL));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

async function derive(secret: string, label: string, message: string): Promise<string> {
  if (secret.length === 0) {
    throw new RangeError("secret は空にできない");
  }
  const encoder = new TextEncoder();
  const root = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign("HMAC", root, encoder.encode(label));
  const key = await crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encodeBase64url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))),
  );
}
