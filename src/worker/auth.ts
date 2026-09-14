/**
 * Google サインイン — `GET /auth/start` と `GET /auth/callback` (design §3・§6)。
 *
 * **start**: state・nonce・PKCE の code_verifier を作り、署名付き cookie に入れて Google へ 302。
 * **callback**: cookie と state を確かめ、code を ID トークンに交換し、検証して uid を導き、登録トークンを発行して
 * ポップアップの HTML (postMessage とコードの表示) を返す。
 *
 * - **redirect_uri は `PUBLIC_ORIGIN` から作る。** リクエストの Host からは作らない。start は戻り先のパラメータを持たない
 * - **cookie と state が通るまで Google に fetch しない**
 * - **callback の応答は成功でも失敗でも cookie を消す。** 開き直しても Google に行かずに止まる
 * - ログは `{"event":"auth","step","status","reason","detail"}` だけ。code・state・cookie・ID トークン・sub・uid・トークンは出さない
 */
import { AUTH_CALLBACK_PATH, AUTH_START_PATH, encodeAuthCode } from "../shared/auth.ts";
import { decodeBase64url, encodeBase64url } from "../shared/base64url.ts";
import { clearAuthCookie, newAuthSession, openAuthCookie, sealAuthCookie } from "./auth-cookie.ts";
import { type AuthFailure, authPageResponse } from "./auth-page.ts";
import { issueEnrollToken } from "./enroll.ts";
import { type GoogleKeys, verifyIdToken } from "./idtoken.ts";
import { plainResponse } from "./responses.ts";
import { uidOf } from "./uid.ts";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Google が返す認可コードの長さの上限。これより長いものは交換に出さない */
const MAX_CODE_LENGTH = 512;

const STATE_BYTES = 16;

export type AuthDeps = {
  readonly db: D1Database;
  /** `WORKER_SECRET` */
  readonly secret: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** `https://grass.soui.dev`。redirect_uri と cookie の基準 */
  readonly publicOrigin: string;
  readonly keys: GoogleKeys;
  /** トークンエンドポイントへの POST。本番は `(url, init) => fetch(url, init)` と包んで渡す */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** 現在時刻 (ミリ秒)。テストで固定する */
  readonly now: () => number;
};

/** ログに出す結果。値そのものは出さない。 */
type Reason =
  | "config"
  | "origin"
  | "redirect"
  | "cookie-missing"
  | "cookie-duplicate"
  | "cookie-format"
  | "cookie-signature"
  | "cookie-expired"
  | "state"
  | "denied"
  | "google-error"
  | "code"
  | "token-rejected"
  | "token-unavailable"
  | "token-response"
  | "jwks"
  | "idtoken"
  | "d1"
  | "issued";

type Step = "start" | "callback";

export async function handleAuthStart(url: URL, deps: AuthDeps): Promise<Response> {
  if (!isConfigured(deps)) {
    log("start", 500, "config");
    return plainResponse(500);
  }
  // 別のホスト (workers.dev) で始めると cookie が callback のホストに届かない。クエリは持ち越さない
  if (url.origin !== deps.publicOrigin) {
    log("start", 302, "origin");
    return redirect(`${deps.publicOrigin}${AUTH_START_PATH}`);
  }

  const session = newAuthSession(deps.now());
  const verifier = encodeBase64url(session.verifier);
  const challenge = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const location = new URL(GOOGLE_AUTH_URL);
  for (const [key, value] of [
    ["client_id", deps.clientId],
    ["redirect_uri", redirectUri(deps)],
    ["response_type", "code"],
    ["scope", "openid"],
    ["state", encodeBase64url(session.state)],
    ["nonce", encodeBase64url(session.nonce)],
    ["code_challenge", encodeBase64url(challenge)],
    ["code_challenge_method", "S256"],
    // 違うアカウントの草に合流すると戻しにくいので、毎回アカウントを選ばせる
    ["prompt", "select_account"],
  ] as const) {
    location.searchParams.set(key, value);
  }

  const response = redirect(location.href);
  response.headers.set("set-cookie", await sealAuthCookie(deps.secret, session));
  log("start", 302, "redirect");
  return response;
}

export async function handleAuthCallback(
  url: URL,
  cookieHeader: string | null,
  deps: AuthDeps,
): Promise<Response> {
  if (!isConfigured(deps)) {
    log("callback", 500, "config");
    return plainResponse(500);
  }
  // postMessage の送り元を常に PUBLIC_ORIGIN に揃える。リダイレクトはしない
  if (url.origin !== deps.publicOrigin) {
    log("callback", 404, "origin");
    return plainResponse(404);
  }

  const nowMs = deps.now();
  const opened = await openAuthCookie(deps.secret, cookieHeader, nowMs);
  if (!opened.ok) {
    return fail(opened.reason === "cookie-signature" ? 403 : 400, opened.reason, "expired");
  }
  const { session } = opened;

  const states = url.searchParams.getAll("state");
  const state = states.length === 1 ? decodeBase64url(states[0] ?? "") : undefined;
  if (state?.length !== STATE_BYTES || !crypto.subtle.timingSafeEqual(state, session.state)) {
    return fail(403, "state", "expired");
  }

  // 利用者が取り消すと error=access_denied で戻る。error_description は読まない
  const errors = url.searchParams.getAll("error");
  if (errors.length > 0) {
    return errors[0] === "access_denied"
      ? fail(400, "denied", "cancelled")
      : fail(400, "google-error", "failed");
  }
  const codes = url.searchParams.getAll("code");
  const code = codes.length === 1 ? (codes[0] ?? "") : "";
  if (code.length === 0 || code.length > MAX_CODE_LENGTH) {
    return fail(400, "code", "failed");
  }

  const exchanged = await exchangeCode(code, encodeBase64url(session.verifier), deps);
  if (!exchanged.ok) {
    return fail(exchanged.status, exchanged.reason, "failed");
  }

  let verified: Awaited<ReturnType<typeof verifyIdToken>>;
  try {
    verified = await verifyIdToken(
      exchanged.idToken,
      { clientId: deps.clientId, nonce: encodeBase64url(session.nonce) },
      { keys: deps.keys, now: deps.now },
    );
  } catch {
    // JWKS が取れない。Google 側の一時的な失敗
    return fail(502, "jwks", "failed");
  }
  if (!verified.ok) {
    return fail(403, "idtoken", "failed", verified.reason);
  }

  let issued: { token: string };
  const uid = await uidOf(deps.secret, verified.sub);
  try {
    issued = await issueEnrollToken(deps.db, uid, nowMs);
  } catch {
    return fail(500, "d1", "failed");
  }

  log("callback", 200, "issued");
  return withClearedCookie(
    await authPageResponse(
      { kind: "issued", code: encodeAuthCode({ uid, token: issued.token }) },
      200,
    ),
  );
}

type Exchanged =
  | { readonly ok: true; readonly idToken: string }
  | { readonly ok: false; readonly status: 400 | 502; readonly reason: Reason };

/** 認可コードを ID トークンに交換する。クライアント認証は本文に入れる (client_secret_post) */
async function exchangeCode(code: string, verifier: string, deps: AuthDeps): Promise<Exchanged> {
  let response: Response;
  try {
    response = await deps.fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: deps.clientId,
        client_secret: deps.clientSecret,
        redirect_uri: redirectUri(deps),
        grant_type: "authorization_code",
        code_verifier: verifier,
      }).toString(),
    });
  } catch {
    return { ok: false, status: 502, reason: "token-unavailable" };
  }
  // 4xx は code の使い回しや期限切れ (invalid_grant)。やり直せば通る
  if (response.status >= 400 && response.status < 500) {
    return { ok: false, status: 400, reason: "token-rejected" };
  }
  if (!response.ok) {
    return { ok: false, status: 502, reason: "token-unavailable" };
  }
  try {
    const body: unknown = await response.json();
    const idToken =
      typeof body === "object" && body !== null && "id_token" in body ? body.id_token : undefined;
    if (typeof idToken === "string" && idToken.length > 0) {
      return { ok: true, idToken };
    }
  } catch {
    // JSON でない
  }
  return { ok: false, status: 502, reason: "token-response" };
}

function redirectUri(deps: AuthDeps): string {
  return `${deps.publicOrigin}${AUTH_CALLBACK_PATH}`;
}

/** 設定が揃っているか。空の値で uid を導いたり ID トークンを比べたりしない */
function isConfigured(deps: AuthDeps): boolean {
  return (
    deps.secret !== "" &&
    deps.clientId !== "" &&
    deps.clientSecret !== "" &&
    URL.canParse(deps.publicOrigin) &&
    new URL(deps.publicOrigin).origin === deps.publicOrigin
  );
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store",
      // scrapbox.io のページの URL (プロジェクト名・ページ名) を Google に渡さない
      "referrer-policy": "no-referrer",
    },
  });
}

async function fail(
  status: 400 | 403 | 500 | 502,
  reason: Reason,
  failure: AuthFailure,
  detail?: string,
): Promise<Response> {
  log("callback", status, reason, detail);
  return withClearedCookie(await authPageResponse({ kind: "failed", failure }, status));
}

function withClearedCookie(response: Response): Response {
  response.headers.set("set-cookie", clearAuthCookie());
  return response;
}

/**
 * Workers Logs に 1 行 (ADR-0013 決定 1)。`detail` は ID トークンの拒否理由 (`nonce`・`aud` など) だけ。
 * **例外のメッセージも出さない** (Google の応答の中身が混ざりうる)。
 */
function log(step: Step, status: number, reason: Reason, detail?: string): void {
  console.log(JSON.stringify({ event: "auth", step, status, reason, detail }));
}
