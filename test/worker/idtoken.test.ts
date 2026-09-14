import { beforeAll, describe, expect, it } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import {
  CLOCK_SKEW_SECONDS,
  GOOGLE_JWKS_URL,
  googleKeys,
  JWKS_REFETCH_INTERVAL_SECONDS,
  verifyIdToken,
} from "../../src/worker/idtoken.ts";
import {
  CLIENT_ID,
  createSigningKey,
  jwksServer,
  NONCE,
  NOW_MS,
  NOW_SECONDS,
  type SigningKey,
  SUB,
  signToken,
  validClaims,
} from "./idtoken-helpers.ts";

const EXPECTED = { clientId: CLIENT_ID, nonce: NONCE };

let current: SigningKey;
let other: SigningKey;

beforeAll(async () => {
  [current, other] = await Promise.all([
    createSigningKey("kid-current"),
    createSigningKey("kid-other"),
  ]);
});

/** 時計と JWKS を 1 組にする。`clock.ms` を進めて時間の経過を作る */
function setup(initial: readonly SigningKey[] = [current]) {
  const clock = { ms: NOW_MS };
  const server = jwksServer(initial);
  const now = () => clock.ms;
  const keys = googleKeys({ fetch: server.fetch, now });
  const verifyToken = (token: string, expected = EXPECTED) =>
    verifyIdToken(token, expected, { keys, now });
  return { clock, server, verifyToken };
}

describe("verifyIdToken — 通るもの", () => {
  it("正しいトークンなら sub を返す", async () => {
    const { verifyToken, server } = setup();
    expect(await verifyToken(await signToken(current))).toEqual({ ok: true, sub: SUB });
    expect(server.calls).toEqual([GOOGLE_JWKS_URL]);
  });

  it("**iss はスキームなしの accounts.google.com も通す**", async () => {
    const { verifyToken } = setup();
    const token = await signToken(current, validClaims({ iss: "accounts.google.com" }));
    expect(await verifyToken(token)).toEqual({ ok: true, sub: SUB });
  });

  it("azp は無くてもよい", async () => {
    const { verifyToken } = setup();
    const token = await signToken(current, validClaims({ azp: undefined }));
    expect(await verifyToken(token)).toEqual({ ok: true, sub: SUB });
  });

  it("Google と同じ形の JWK (alg と use を含む) を workerd の importKey で読める", async () => {
    const { verifyToken } = setup();
    expect(current.jwk).toMatchObject({ alg: "RS256", use: "sig" });
    expect((await verifyToken(await signToken(current))).ok).toBe(true);
  });
});

describe("verifyIdToken — alg と署名", () => {
  it("**alg が none なら拒否し、JWKS を取りに行かない**", async () => {
    const { verifyToken, server } = setup();
    const [header, payload] = (await signToken(current, validClaims(), { alg: "none" })).split(".");
    expect(await verifyToken(`${header}.${payload}.`)).toEqual({ ok: false, reason: "alg" });
    expect(server.calls).toHaveLength(0);
  });

  it("**HS256 (公開鍵の値を HMAC の鍵にする混同) を拒否し、JWKS を取りに行かない**", async () => {
    const { verifyToken, server } = setup();
    const unsigned = (await signToken(current, validClaims(), { alg: "HS256" }))
      .split(".")
      .slice(0, 2)
      .join(".");
    const hmacKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(current.jwk.n),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(unsigned));
    const token = `${unsigned}.${encodeBase64url(new Uint8Array(mac))}`;
    expect(await verifyToken(token)).toEqual({ ok: false, reason: "alg" });
    expect(server.calls).toHaveLength(0);
  });

  it("RS256 以外の RSA (RS512) も拒否する", async () => {
    const { verifyToken } = setup();
    const token = await signToken(current, validClaims(), { alg: "RS512" });
    expect(await verifyToken(token)).toEqual({ ok: false, reason: "alg" });
  });

  it("kid が無い・空なら拒否する", async () => {
    const { verifyToken } = setup();
    expect(await verifyToken(await signToken(current, validClaims(), { kid: undefined }))).toEqual({
      ok: false,
      reason: "kid",
    });
    expect(await verifyToken(await signToken(current, validClaims(), { kid: "" }))).toEqual({
      ok: false,
      reason: "kid",
    });
  });

  it("payload を書き換えたら signature", async () => {
    const { verifyToken } = setup();
    const [header, , signature] = (await signToken(current)).split(".");
    const forged = encodeBase64url(
      new TextEncoder().encode(JSON.stringify(validClaims({ sub: "1" }))),
    );
    expect(await verifyToken(`${header}.${forged}.${signature}`)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("JWKS にある別の鍵で署名されていたら signature", async () => {
    const { verifyToken } = setup([current, other]);
    const token = await signToken(other, validClaims(), { kid: current.kid });
    expect(await verifyToken(token)).toEqual({ ok: false, reason: "signature" });
  });
});

describe("verifyIdToken — 形", () => {
  it.each([
    ["区切りが 2 つ", "a.b"],
    ["区切りが 4 つ", "a.b.c.d"],
    ["空", ""],
  ])("%s なら format", async (_, token) => {
    const { verifyToken } = setup();
    expect(await verifyToken(token)).toEqual({ ok: false, reason: "format" });
  });

  it("正規形でない base64url (パディング・余りビット) なら format", async () => {
    const { verifyToken } = setup();
    const [header, payload, signature] = (await signToken(current)).split(".");
    expect(await verifyToken(`${header}=.${payload}.${signature}`)).toEqual({
      ok: false,
      reason: "format",
    });
    // 256 バイトの署名は 342 文字で、最後の文字の下位 4 bit は使われない。そこだけを立てる
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(signature?.at(-1) ?? "");
    const noncanonical = `${signature?.slice(0, -1)}${alphabet[last + 1]}`;
    expect(await verifyToken(`${header}.${payload}.${noncanonical}`)).toEqual({
      ok: false,
      reason: "format",
    });
  });

  it("JSON でない・object でない・UTF-8 でないなら format", async () => {
    const { verifyToken } = setup();
    const [, payload, signature] = (await signToken(current)).split(".");
    const encode = (bytes: Uint8Array) => encodeBase64url(bytes);
    const text = (value: string) => encode(new TextEncoder().encode(value));
    for (const header of [
      text("not json"),
      text("[1]"),
      text("null"),
      encode(new Uint8Array([0xff])),
    ]) {
      expect(await verifyToken(`${header}.${payload}.${signature}`)).toEqual({
        ok: false,
        reason: "format",
      });
    }
  });

  it("長すぎるトークンはデコードしない", async () => {
    const { verifyToken, server } = setup();
    const token = await signToken(current, validClaims({ pad: "x".repeat(8192) }));
    expect(await verifyToken(token)).toEqual({ ok: false, reason: "format" });
    expect(server.calls).toHaveLength(0);
  });
});

describe("verifyIdToken — クレーム", () => {
  it.each([
    ["iss がスキームつきの http", { iss: "http://accounts.google.com" }, "iss"],
    ["iss が別のドメイン", { iss: "https://accounts.google.com.example" }, "iss"],
    ["iss が無い", { iss: undefined }, "iss"],
    ["aud が別のクライアント", { aud: "other.apps.googleusercontent.com" }, "aud"],
    ["**aud が配列** (値が含まれていても拒否)", { aud: [CLIENT_ID] }, "aud"],
    ["azp が別のクライアント", { azp: "other.apps.googleusercontent.com" }, "azp"],
    ["exp が無い", { exp: undefined }, "exp"],
    ["exp が文字列", { exp: String(NOW_SECONDS + 3600) }, "exp"],
    ["iat が無い", { iat: undefined }, "iat"],
    ["**nonce が違う**", { nonce: "other-nonce" }, "nonce"],
    ["nonce が無い", { nonce: undefined }, "nonce"],
    ["sub が無い", { sub: undefined }, "sub"],
    ["sub が空", { sub: "" }, "sub"],
    ["sub が数値", { sub: 42 }, "sub"],
    ["sub が 256 文字", { sub: "1".repeat(256) }, "sub"],
  ])("%s", async (_, overrides, reason) => {
    const { verifyToken } = setup();
    const token = await signToken(current, validClaims(overrides));
    expect(await verifyToken(token)).toEqual({ ok: false, reason });
  });

  it("sub は 255 文字まで通す", async () => {
    const { verifyToken } = setup();
    const token = await signToken(current, validClaims({ sub: "1".repeat(255) }));
    expect(await verifyToken(token)).toEqual({ ok: true, sub: "1".repeat(255) });
  });

  it(`**exp は ${CLOCK_SKEW_SECONDS} 秒のずれまで通し、それを過ぎたら拒否する**`, async () => {
    const { verifyToken, clock } = setup();
    const token = await signToken(current, validClaims({ exp: NOW_SECONDS }));

    clock.ms = NOW_MS + CLOCK_SKEW_SECONDS * 1000 - 1;
    expect((await verifyToken(token)).ok).toBe(true);

    clock.ms = NOW_MS + CLOCK_SKEW_SECONDS * 1000;
    expect(await verifyToken(token)).toEqual({ ok: false, reason: "exp" });
  });

  it(`iat は ${CLOCK_SKEW_SECONDS} 秒先まで通し、それより未来なら拒否する`, async () => {
    const { verifyToken } = setup();
    const ok = await signToken(current, validClaims({ iat: NOW_SECONDS + CLOCK_SKEW_SECONDS }));
    expect((await verifyToken(ok)).ok).toBe(true);

    const future = await signToken(
      current,
      validClaims({ iat: NOW_SECONDS + CLOCK_SKEW_SECONDS + 1 }),
    );
    expect(await verifyToken(future)).toEqual({ ok: false, reason: "iat" });
  });

  it("期待する clientId か nonce が空なら、呼び出し側の誤りとして例外", async () => {
    const { verifyToken } = setup();
    const token = await signToken(current);
    await expect(verifyToken(token, { clientId: CLIENT_ID, nonce: "" })).rejects.toThrow(
      RangeError,
    );
    await expect(verifyToken(token, { clientId: "", nonce: NONCE })).rejects.toThrow(RangeError);
  });
});

describe("googleKeys — JWKS の保持", () => {
  it("期限内は取り直さない", async () => {
    const { verifyToken, server, clock } = setup();
    const token = await signToken(current);
    await verifyToken(token);
    clock.ms = NOW_MS + 23_000 * 1000;
    await verifyToken(token);
    expect(server.calls).toHaveLength(1);
  });

  it("max-age を過ぎたら取り直す", async () => {
    const { verifyToken, server, clock } = setup();
    const token = await signToken(current, validClaims({ exp: NOW_SECONDS + 86_400 }));
    await verifyToken(token);
    clock.ms = NOW_MS + 23_651 * 1000;
    await verifyToken(token);
    expect(server.calls).toHaveLength(2);
  });

  it("Age の分だけ期限を縮める", async () => {
    const { verifyToken, server, clock } = setup();
    server.headers = { "cache-control": "public, max-age=3600", age: "3000" };
    const token = await signToken(current);
    await verifyToken(token);
    clock.ms = NOW_MS + 599 * 1000;
    await verifyToken(token);
    expect(server.calls).toHaveLength(1);
    clock.ms = NOW_MS + 600 * 1000;
    await verifyToken(token);
    expect(server.calls).toHaveLength(2);
  });

  it("Cache-Control が無ければ 60 秒で取り直す", async () => {
    const { verifyToken, server, clock } = setup();
    server.headers = {};
    const token = await signToken(current);
    await verifyToken(token);
    clock.ms = NOW_MS + 60 * 1000;
    await verifyToken(token);
    expect(server.calls).toHaveLength(2);
  });

  it("**鍵の入れ替え: 未知の kid で 1 回だけ取り直し、新しい鍵で通る**", async () => {
    const { verifyToken, server, clock } = setup([current]);
    await verifyToken(await signToken(current));

    // Google が新しい鍵を配り始めた
    server.keys = [current, other];
    clock.ms = NOW_MS + JWKS_REFETCH_INTERVAL_SECONDS * 1000;
    expect(await verifyToken(await signToken(other))).toEqual({ ok: true, sub: SUB });
    expect(server.calls).toHaveLength(2);
  });

  it("**知らない kid が続いても、取り直しは間隔を空けてからだけ**", async () => {
    const { verifyToken, server, clock } = setup([current]);
    const unknown = await signToken(other);
    await verifyToken(await signToken(current));

    clock.ms = NOW_MS + JWKS_REFETCH_INTERVAL_SECONDS * 1000;
    expect(await verifyToken(unknown)).toEqual({ ok: false, reason: "kid" });
    expect(server.calls).toHaveLength(2);

    // 取り直した直後に続けて来ても取りに行かない
    clock.ms += JWKS_REFETCH_INTERVAL_SECONDS * 1000 - 1;
    expect(await verifyToken(unknown)).toEqual({ ok: false, reason: "kid" });
    expect(await verifyToken(unknown)).toEqual({ ok: false, reason: "kid" });
    expect(server.calls).toHaveLength(2);
  });

  it("初回の取得で kid が無ければ、その場で取り直さない", async () => {
    const { verifyToken, server } = setup([current]);
    expect(await verifyToken(await signToken(other))).toEqual({ ok: false, reason: "kid" });
    expect(server.calls).toHaveLength(1);
  });

  it("JWKS が 200 でなければ例外 (callback が 500 にする)", async () => {
    const { verifyToken, server } = setup();
    server.status = 503;
    await expect(verifyToken(await signToken(current))).rejects.toThrow();
  });

  it("使える鍵が 1 本も無ければ例外。壊れた鍵や用途の違う鍵は飛ばす", async () => {
    const broken = { ...current, jwk: { ...current.jwk, n: "AQAB", kid: "broken" } };
    const encryption = { ...other, jwk: { ...other.jwk, use: "enc" } };
    const { verifyToken, server } = setup([broken, encryption]);
    await expect(verifyToken(await signToken(current))).rejects.toThrow();
    expect(server.calls).toHaveLength(1);

    const next = setup([broken, encryption, current]);
    expect(await next.verifyToken(await signToken(current))).toEqual({ ok: true, sub: SUB });
  });
});
