/**
 * ID トークンのテストの足場。Google の代わりに RSA の鍵を作り、同じ形の JWKS と JWT を作る。
 */
import { encodeBase64url } from "../../src/shared/base64url.ts";

export const CLIENT_ID = "123456789-test.apps.googleusercontent.com";
export const NONCE = "test-nonce-0123456789";
export const SUB = "109876543210987654321";

/** 2026-09-14T00:00:00Z */
export const NOW_MS = Date.UTC(2026, 8, 14);
export const NOW_SECONDS = NOW_MS / 1000;

export type SigningKey = {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  /** Google の JWKS と同じ形 (`alg` と `use` を含む) */
  readonly jwk: JsonWebKey & { kid: string };
};

export async function createSigningKey(kid: string): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { kty: "RSA", alg: "RS256", use: "sig", kid, n: exported.n, e: exported.e },
  };
}

/** 検証を通るクレーム。上書きしたいものだけ渡す (`undefined` を渡すとそのクレームを消す) */
export function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const claims: Record<string, unknown> = {
    iss: "https://accounts.google.com",
    azp: CLIENT_ID,
    aud: CLIENT_ID,
    sub: SUB,
    nonce: NONCE,
    iat: NOW_SECONDS - 5,
    exp: NOW_SECONDS + 3600,
    ...overrides,
  };
  for (const [name, value] of Object.entries(claims)) {
    if (value === undefined) {
      delete claims[name];
    }
  }
  return claims;
}

function encodeJson(value: unknown): string {
  return encodeBase64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** RS256 で署名した JWT。`header` で alg や kid を上書きできる */
export async function signToken(
  key: SigningKey,
  claims: Record<string, unknown> = validClaims(),
  header: Record<string, unknown> = {},
): Promise<string> {
  const input = `${encodeJson({ alg: "RS256", kid: key.kid, typ: "JWT", ...header })}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${encodeBase64url(new Uint8Array(signature))}`;
}

/** JWKS の応答を返す fetch の代わり。呼ばれた回数と URL を数える */
export function jwksServer(
  initial: readonly SigningKey[],
  headers: HeadersInit = { "cache-control": "public, max-age=23651, must-revalidate" },
) {
  const server = {
    calls: [] as string[],
    keys: [...initial],
    headers,
    status: 200,
    fetch: async (url: string): Promise<Response> => {
      server.calls.push(url);
      return new Response(JSON.stringify({ keys: server.keys.map((key) => key.jwk) }), {
        status: server.status,
        headers: server.headers,
      });
    },
  };
  return server;
}
