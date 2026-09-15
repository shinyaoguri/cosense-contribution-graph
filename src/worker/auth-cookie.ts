/**
 * サインインの往復のあいだ state・nonce・PKCE の code_verifier を持つ署名付き cookie (design §3)。
 *
 * **KV は使わない。** eventual consistency が OAuth の往復時間と衝突する (research §6)。
 *
 * ```
 * __Host-grass-auth=<base64url(payload)>.<base64url(HMAC)>; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax
 * payload = ver(1) | issuedAt(u32 BE、unix 秒) | mode(1) | state(16) | nonce(16) | code_verifier(32)   = 70 バイト
 * ```
 *
 * - **`__Host-` にする。** `Domain` を付けられないので、`soui.dev` の別のサブドメインから cookie を差し込めない。
 *   署名付きでも、攻撃者が自分で `/auth/start` を開いて得た正規の cookie を被害者に持たせれば、
 *   被害者の端末を攻撃者の uid に登録させられる (ログイン CSRF)
 * - **HMAC の鍵は `WORKER_SECRET` から用途を分けて導く。** uid の導出 (`"google:" + sub`) と同じ鍵を直接使わない
 * - **暗号化はしない。** 中身は乱数だけで、読めるのは HttpOnly の cookie を持つ本人のブラウザ。
 *   code_verifier が読めても、トークンの交換には client secret が要る
 * - 期限はサーバでも見る。`Max-Age` はブラウザが守るだけ
 * - **戻り先 (`mode`) も cookie に入れて署名する** (ADR-0018)。クエリで持ち回すと、
 *   callback の URL を作り替えるだけで戻り先を変えられる
 */
import { decodeBase64url, encodeBase64url } from "../shared/base64url.ts";

export const AUTH_COOKIE_NAME = "__Host-grass-auth";

/** サインインを始めてから戻ってくるまでの上限 (privacy.md「Cookie」) */
export const AUTH_COOKIE_MAX_AGE_SECONDS = 600;

/** 発行時刻が未来でも許すずれ */
const FUTURE_SKEW_SECONDS = 60;

/** 形が変わったら上げる。発行済みは最長 10 分で切れるので移行は要らない (2 = mode を足した) */
const COOKIE_VERSION = 2;
const STATE_BYTES = 16;
const NONCE_BYTES = 16;
/** RFC 7636 の下限 43 文字ちょうどになる */
const VERIFIER_BYTES = 32;
const PAYLOAD_BYTES = 1 + 4 + 1 + STATE_BYTES + NONCE_BYTES + VERIFIER_BYTES;
const MAC_BYTES = 32;

/** 鍵を導く用途のラベル。変えても影響は発行済みの cookie (最長 10 分) が無効になるだけ */
const KEY_LABEL = "cosense-grass:auth-cookie:v1";

const COOKIE_ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Lax";

/**
 * サインインの後にどこへ返すか。
 *
 * - `popup` — Cosense のポップアップ。登録トークンを発行して `postMessage` する (既定)
 * - `account` — 管理のページ。**登録トークンは発行せず**、セッション cookie を付けて `/account` へ 302
 */
export type AuthMode = "popup" | "account";

const MODE_CODE: Record<AuthMode, number> = { popup: 0, account: 1 };

export type AuthSession = {
  /** unix 秒 */
  readonly issuedAt: number;
  readonly mode: AuthMode;
  readonly state: Uint8Array<ArrayBuffer>;
  readonly nonce: Uint8Array<ArrayBuffer>;
  readonly verifier: Uint8Array<ArrayBuffer>;
};

type OpenError =
  | "cookie-missing"
  | "cookie-duplicate"
  | "cookie-format"
  | "cookie-signature"
  | "cookie-expired";

type OpenResult =
  | { readonly ok: true; readonly session: AuthSession }
  | { readonly ok: false; readonly reason: OpenError };

export function newAuthSession(nowMs: number, mode: AuthMode = "popup"): AuthSession {
  return {
    issuedAt: Math.floor(nowMs / 1000),
    mode,
    state: crypto.getRandomValues(new Uint8Array(STATE_BYTES)),
    nonce: crypto.getRandomValues(new Uint8Array(NONCE_BYTES)),
    verifier: crypto.getRandomValues(new Uint8Array(VERIFIER_BYTES)),
  };
}

/** `Set-Cookie` の値。 */
export async function sealAuthCookie(secret: string, session: AuthSession): Promise<string> {
  const payload = new Uint8Array(PAYLOAD_BYTES);
  const view = new DataView(payload.buffer);
  view.setUint8(0, COOKIE_VERSION);
  view.setUint32(1, session.issuedAt);
  view.setUint8(5, MODE_CODE[session.mode]);
  payload.set(session.state, 6);
  payload.set(session.nonce, 6 + STATE_BYTES);
  payload.set(session.verifier, 6 + STATE_BYTES + NONCE_BYTES);
  const mac = await crypto.subtle.sign("HMAC", await cookieKey(secret, "sign"), payload);
  const value = `${encodeBase64url(payload)}.${encodeBase64url(new Uint8Array(mac))}`;
  return `${AUTH_COOKIE_NAME}=${value}; Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}; ${COOKIE_ATTRIBUTES}`;
}

/** cookie を消す `Set-Cookie` の値。属性は発行時と揃える */
export function clearAuthCookie(): string {
  return `${AUTH_COOKIE_NAME}=; Max-Age=0; ${COOKIE_ATTRIBUTES}`;
}

/** リクエストの `Cookie` ヘッダから読み、署名と期限を確かめる。 */
export async function openAuthCookie(
  secret: string,
  header: string | null,
  nowMs: number,
): Promise<OpenResult> {
  const prefix = `${AUTH_COOKIE_NAME}=`;
  const values = (header ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(prefix))
    .map((pair) => pair.slice(prefix.length));
  if (values.length === 0) {
    return { ok: false, reason: "cookie-missing" };
  }
  // 同名が 2 つ届くのは、別の経路で差し込まれたとき。どちらを信じるか決めずに拒否する
  if (values.length > 1) {
    return { ok: false, reason: "cookie-duplicate" };
  }

  const parts = (values[0] ?? "").split(".");
  const payload = parts.length === 2 ? decodeBase64url(parts[0] ?? "") : undefined;
  const mac = parts.length === 2 ? decodeBase64url(parts[1] ?? "") : undefined;
  if (
    payload?.length !== PAYLOAD_BYTES ||
    mac?.length !== MAC_BYTES ||
    payload[0] !== COOKIE_VERSION
  ) {
    return { ok: false, reason: "cookie-format" };
  }
  if (!(await crypto.subtle.verify("HMAC", await cookieKey(secret, "verify"), mac, payload))) {
    return { ok: false, reason: "cookie-signature" };
  }

  const issuedAt = new DataView(payload.buffer).getUint32(1);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (
    nowSeconds - issuedAt > AUTH_COOKIE_MAX_AGE_SECONDS ||
    issuedAt > nowSeconds + FUTURE_SKEW_SECONDS
  ) {
    return { ok: false, reason: "cookie-expired" };
  }
  // 知らない mode は既定に落とす (cookie は署名済みなので、ここに来るのは古い版が書いたときだけ)
  const mode: AuthMode = payload[5] === MODE_CODE.account ? "account" : "popup";
  return {
    ok: true,
    session: {
      issuedAt,
      mode,
      state: payload.slice(6, 6 + STATE_BYTES),
      nonce: payload.slice(6 + STATE_BYTES, 6 + STATE_BYTES + NONCE_BYTES),
      verifier: payload.slice(6 + STATE_BYTES + NONCE_BYTES),
    },
  };
}

/** `HMAC(WORKER_SECRET, KEY_LABEL)` を鍵にする。uid の導出と鍵を分ける */
async function cookieKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
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
