/**
 * Google の ID トークンを検証する (design §3「ID トークンの検証」)。
 *
 * 呼ぶのは `/auth/callback` (段階 4。OAuth クライアントが要るのでまだ無い)。ID トークンは callback が
 * Google のトークンエンドポイントから直接受け取るものだが、**署名とクレームは必ず自分で見る**。
 * `tokeninfo` エンドポイントはデバッグ専用なので使わない。
 *
 * 順序は「署名が通るまでクレームを信用しない」。
 *
 * 1. 形 (3 つに区切れる・正規形の base64url・UTF-8・JSON の object)
 * 2. **`alg` は RS256 だけ。** ここで落ちたら JWKS を取りに行かない (`none` や HS256 の混入を弾く)
 * 3. `kid` で Google の公開鍵を引く
 * 4. RSASSA-PKCS1-v1_5 / SHA-256 で署名を検証する
 * 5. `iss`・`aud`・`azp`・`exp`・`iat`・`nonce`・`sub`
 */
import { decodeBase64url } from "../shared/base64url.ts";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

/** **スキームなしも正当** (design §3)。自前実装でよく落ちる */
const ISSUERS: ReadonlySet<unknown> = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);

/**
 * `exp` と `iat` で許す時計のずれ。ID トークンは callback が受け取った直後に検証するので小さくてよい。
 */
export const CLOCK_SKEW_SECONDS = 60;

/** Google の ID トークンは 1〜2KB。これより長いものはデコードせずに捨てる */
const MAX_TOKEN_LENGTH = 8192;

/** Google の `sub` は 255 文字以内 */
const MAX_SUB_LENGTH = 255;

/** JWKS の保持時間の下限と上限。`Cache-Control` が無い・極端なときに丸める */
const MIN_JWKS_TTL_SECONDS = 60;
const MAX_JWKS_TTL_SECONDS = 86_400;

/** **未知の `kid` で取り直す間隔の下限。** 偽の kid を並べて Google への取得を連発させない */
export const JWKS_REFETCH_INTERVAL_SECONDS = 60;

/** 拒否した理由。ログに出す (トークンやクレームの値は出さない)。 */
type IdTokenError =
  | "format"
  | "alg"
  | "kid"
  | "signature"
  | "iss"
  | "aud"
  | "azp"
  | "exp"
  | "iat"
  | "nonce"
  | "sub";

export type IdTokenResult =
  | { readonly ok: true; readonly sub: string }
  | { readonly ok: false; readonly reason: IdTokenError };

export type IdTokenExpectation = {
  /** OAuth クライアント ID */
  readonly clientId: string;
  /** `/auth/start` が署名付き cookie に入れた nonce */
  readonly nonce: string;
};

/** Google の公開鍵を kid で引く。無ければ `undefined`。JWKS の取得に失敗したら throw する。 */
export type GoogleKeys = {
  readonly key: (kid: string) => Promise<CryptoKey | undefined>;
};

export type IdTokenDeps = {
  readonly keys: GoogleKeys;
  /** 現在時刻 (ミリ秒)。テストで固定する */
  readonly now: () => number;
};

type Json = Record<string, unknown>;

export async function verifyIdToken(
  token: string,
  expected: IdTokenExpectation,
  deps: IdTokenDeps,
): Promise<IdTokenResult> {
  // 空の期待値で比べると「クレームが無い」ことを見逃しうる。呼び出し側の誤り
  if (expected.clientId === "" || expected.nonce === "") {
    throw new RangeError("clientId と nonce は空にできない");
  }

  if (token.length > MAX_TOKEN_LENGTH) {
    return fail("format");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return fail("format");
  }
  const [encodedHeader = "", encodedPayload = "", encodedSignature = ""] = parts;
  const header = decodeJson(encodedHeader);
  const payload = decodeJson(encodedPayload);
  const signature = decodeBase64url(encodedSignature);
  if (header === undefined || payload === undefined || signature === undefined) {
    return fail("format");
  }

  if (header.alg !== "RS256") {
    return fail("alg");
  }
  if (typeof header.kid !== "string" || header.kid === "") {
    return fail("kid");
  }
  const key = await deps.keys.key(header.kid);
  if (key === undefined) {
    return fail("kid");
  }
  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed))) {
    return fail("signature");
  }

  const nowMs = deps.now();
  const skewMs = CLOCK_SKEW_SECONDS * 1000;
  if (!ISSUERS.has(payload.iss)) {
    return fail("iss");
  }
  // Google の ID トークンの aud は文字列。配列の形は受け付けない (厳しい側に倒す)
  if (payload.aud !== expected.clientId) {
    return fail("aud");
  }
  if ("azp" in payload && payload.azp !== expected.clientId) {
    return fail("azp");
  }
  if (!isFiniteNumber(payload.exp) || nowMs >= payload.exp * 1000 + skewMs) {
    return fail("exp");
  }
  if (!isFiniteNumber(payload.iat) || payload.iat * 1000 > nowMs + skewMs) {
    return fail("iat");
  }
  if (payload.nonce !== expected.nonce) {
    return fail("nonce");
  }
  const { sub } = payload;
  if (typeof sub !== "string" || sub.length === 0 || sub.length > MAX_SUB_LENGTH) {
    return fail("sub");
  }
  return { ok: true, sub };
}

export type GoogleKeysDeps = {
  /**
   * JWKS を取る。本番は `(url) => fetch(url)` と包んで渡す
   * (workerd では `fetch` をオブジェクトのメソッドとして呼ぶと Illegal invocation になる)
   */
  readonly fetch: (url: string) => Promise<Response>;
  /** 現在時刻 (ミリ秒)。テストで固定する */
  readonly now: () => number;
};

type KeySet = {
  readonly keys: ReadonlyMap<string, CryptoKey>;
  readonly fetchedMs: number;
  readonly expiresMs: number;
};

/**
 * Google の JWKS を `Cache-Control` に従って保持する (design §3)。
 *
 * - 本番では**モジュールの最上位で 1 つ作り、isolate の中で使い回す**
 * - 保持するのは読み込み済みの `CryptoKey` と期限だけ。**取得中の Promise はリクエストをまたいで共有しない**
 *   (workerd では別のリクエストの I/O を待てない)。期限切れが同時に来たら 2 回取るが、サインインは稀なので受け入れる
 * - **未知の `kid` が来たら 1 回だけ取り直す** (鍵の入れ替え)。ただし前回の取得から
 *   `JWKS_REFETCH_INTERVAL_SECONDS` 経っていなければ取り直さない
 */
export function googleKeys(deps: GoogleKeysDeps): GoogleKeys {
  let cache: KeySet | undefined;

  const load = async (): Promise<KeySet> => {
    const fetchedMs = deps.now();
    const response = await deps.fetch(GOOGLE_JWKS_URL);
    if (!response.ok) {
      throw new Error(`JWKS の取得に失敗した: ${response.status}`);
    }
    const keys = await importJwks(await response.json());
    const ttlSeconds = jwksTtlSeconds(response.headers);
    cache = { keys, fetchedMs, expiresMs: fetchedMs + ttlSeconds * 1000 };
    return cache;
  };

  return {
    async key(kid) {
      const nowMs = deps.now();
      if (cache === undefined || nowMs >= cache.expiresMs) {
        return (await load()).keys.get(kid);
      }
      const hit = cache.keys.get(kid);
      if (hit !== undefined || nowMs - cache.fetchedMs < JWKS_REFETCH_INTERVAL_SECONDS * 1000) {
        return hit;
      }
      return (await load()).keys.get(kid);
    },
  };
}

/**
 * JWKS の本文から検証用の鍵を読み込む。
 *
 * `importKey("jwk")` には **`{kty, n, e}` だけ**を渡す。Google の JWK が持つ `alg` / `use` を含めると、
 * 実装によっては usage との整合で失敗する (research §6)。読み込めない鍵は飛ばし、1 本も残らなければ throw する。
 */
async function importJwks(body: unknown): Promise<Map<string, CryptoKey>> {
  const entries = isObject(body) && Array.isArray(body.keys) ? body.keys : [];
  const keys = new Map<string, CryptoKey>();
  for (const jwk of entries) {
    if (
      !isObject(jwk) ||
      jwk.kty !== "RSA" ||
      typeof jwk.kid !== "string" ||
      typeof jwk.n !== "string" ||
      typeof jwk.e !== "string" ||
      (jwk.use !== undefined && jwk.use !== "sig") ||
      (jwk.alg !== undefined && jwk.alg !== "RS256")
    ) {
      continue;
    }
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(jwk.kid, key);
    } catch {
      // 壊れた鍵が 1 本あっても、残りで検証できる
    }
  }
  if (keys.size === 0) {
    throw new Error("JWKS に使える鍵が無い");
  }
  return keys;
}

/** `max-age` から `Age` を引き、下限と上限に丸める。`max-age` が無ければ下限。 */
function jwksTtlSeconds(headers: Headers): number {
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(headers.get("cache-control") ?? "")?.[1];
  if (maxAge === undefined) {
    return MIN_JWKS_TTL_SECONDS;
  }
  const age = Number(/^\d+$/.exec(headers.get("age") ?? "")?.[0] ?? 0);
  return Math.min(Math.max(Number(maxAge) - age, MIN_JWKS_TTL_SECONDS), MAX_JWKS_TTL_SECONDS);
}

function decodeJson(encoded: string): Json | undefined {
  const bytes = decodeBase64url(encoded);
  if (bytes === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function fail(reason: IdTokenError): IdTokenResult {
  return { ok: false, reason };
}
