import { describe, expect, it } from "vitest";
import { decodeBase64url, encodeBase64url } from "../../src/shared/base64url.ts";
import {
  AUTH_COOKIE_MAX_AGE_SECONDS,
  AUTH_COOKIE_NAME,
  clearAuthCookie,
  newAuthSession,
  openAuthCookie,
  sealAuthCookie,
} from "../../src/worker/auth-cookie.ts";

const SECRET = "test-worker-secret";
const NOW = Date.UTC(2026, 8, 14, 3, 0, 0);

/** `Set-Cookie` の値から、リクエストの `Cookie` ヘッダに載る `名前=値` を取り出す */
function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

async function sealed(nowMs = NOW) {
  const session = newAuthSession(nowMs);
  return { session, setCookie: await sealAuthCookie(SECRET, session) };
}

describe("sealAuthCookie と openAuthCookie", () => {
  it("往復で中身が戻る", async () => {
    const { session, setCookie } = await sealed();
    expect(await openAuthCookie(SECRET, cookiePair(setCookie), NOW)).toEqual({ ok: true, session });
  });

  it("**`__Host-` で Domain を付けず、Path=/・Secure・HttpOnly・SameSite=Lax・Max-Age=600**", async () => {
    const { setCookie } = await sealed();
    const [, ...attributes] = setCookie.split("; ");
    expect(setCookie.startsWith(`${AUTH_COOKIE_NAME}=`)).toBe(true);
    expect(AUTH_COOKIE_NAME.startsWith("__Host-")).toBe(true);
    expect(attributes.sort()).toEqual([
      "HttpOnly",
      "Max-Age=600",
      "Path=/",
      "SameSite=Lax",
      "Secure",
    ]);
  });

  it("消す cookie は同じ属性で Max-Age=0", () => {
    expect(clearAuthCookie()).toBe(
      `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`,
    );
  });

  it("毎回違う乱数を持つ", () => {
    const a = newAuthSession(NOW);
    const b = newAuthSession(NOW);
    expect(a.state).not.toEqual(b.state);
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.verifier).not.toEqual(b.verifier);
    expect(encodeBase64url(a.verifier)).toHaveLength(43);
  });

  it("他の cookie と一緒に届いても読める", async () => {
    const { session, setCookie } = await sealed();
    const header = `theme=dark; ${cookiePair(setCookie)}; other=1`;
    expect(await openAuthCookie(SECRET, header, NOW)).toEqual({ ok: true, session });
  });

  it("cookie が無ければ cookie-missing", async () => {
    expect(await openAuthCookie(SECRET, null, NOW)).toEqual({
      ok: false,
      reason: "cookie-missing",
    });
    expect(await openAuthCookie(SECRET, "theme=dark", NOW)).toEqual({
      ok: false,
      reason: "cookie-missing",
    });
  });

  it("**同じ名前が 2 つ届いたら cookie-duplicate** (差し込まれた cookie を選ばない)", async () => {
    const first = await sealed();
    const second = await sealed();
    const header = `${cookiePair(first.setCookie)}; ${cookiePair(second.setCookie)}`;
    expect(await openAuthCookie(SECRET, header, NOW)).toEqual({
      ok: false,
      reason: "cookie-duplicate",
    });
  });

  it("**payload を 1 バイト書き換えたら cookie-signature**", async () => {
    const { setCookie } = await sealed();
    const [payload = "", mac] = cookiePair(setCookie)
      .slice(AUTH_COOKIE_NAME.length + 1)
      .split(".");
    const bytes = decodeBase64url(payload) ?? new Uint8Array();
    bytes[10] = (bytes[10] ?? 0) ^ 1;
    const header = `${AUTH_COOKIE_NAME}=${encodeBase64url(bytes)}.${mac}`;
    expect(await openAuthCookie(SECRET, header, NOW)).toEqual({
      ok: false,
      reason: "cookie-signature",
    });
  });

  it("別の secret で作った cookie は cookie-signature", async () => {
    const setCookie = await sealAuthCookie("other-secret", newAuthSession(NOW));
    expect(await openAuthCookie(SECRET, cookiePair(setCookie), NOW)).toEqual({
      ok: false,
      reason: "cookie-signature",
    });
  });

  it("**WORKER_SECRET をそのまま鍵にした MAC では通らない** (用途ごとに鍵を分けている)", async () => {
    const { setCookie } = await sealed();
    const [payload = ""] = cookiePair(setCookie)
      .slice(AUTH_COOKIE_NAME.length + 1)
      .split(".");
    const raw = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", raw, decodeBase64url(payload) ?? new Uint8Array());
    const header = `${AUTH_COOKIE_NAME}=${payload}.${encodeBase64url(new Uint8Array(mac))}`;
    expect(await openAuthCookie(SECRET, header, NOW)).toEqual({
      ok: false,
      reason: "cookie-signature",
    });
  });

  it(`**発行から ${AUTH_COOKIE_MAX_AGE_SECONDS} 秒までは読み、それを過ぎたら cookie-expired**`, async () => {
    const { setCookie } = await sealed();
    const pair = cookiePair(setCookie);
    expect((await openAuthCookie(SECRET, pair, NOW + AUTH_COOKIE_MAX_AGE_SECONDS * 1000)).ok).toBe(
      true,
    );
    expect(
      await openAuthCookie(SECRET, pair, NOW + (AUTH_COOKIE_MAX_AGE_SECONDS + 1) * 1000),
    ).toEqual({
      ok: false,
      reason: "cookie-expired",
    });
  });

  it("発行時刻が 60 秒より未来なら cookie-expired", async () => {
    const pair = cookiePair((await sealed(NOW + 61_000)).setCookie);
    expect(await openAuthCookie(SECRET, pair, NOW)).toEqual({
      ok: false,
      reason: "cookie-expired",
    });
    expect(
      (await openAuthCookie(SECRET, cookiePair((await sealed(NOW + 60_000)).setCookie), NOW)).ok,
    ).toBe(true);
  });

  it.each([
    ["空", ""],
    ["区切りが無い", "abc"],
    ["区切りが 2 つ", "a.b.c"],
    [
      "短い payload",
      `${encodeBase64url(new Uint8Array(68))}.${encodeBase64url(new Uint8Array(32))}`,
    ],
    [
      "短い MAC",
      `${encodeBase64url(new Uint8Array(69).fill(1))}.${encodeBase64url(new Uint8Array(31))}`,
    ],
    [
      "版が違う",
      `${encodeBase64url(new Uint8Array(69).fill(2))}.${encodeBase64url(new Uint8Array(32))}`,
    ],
  ])("%s なら cookie-format", async (_, value) => {
    expect(await openAuthCookie(SECRET, `${AUTH_COOKIE_NAME}=${value}`, NOW)).toEqual({
      ok: false,
      reason: "cookie-format",
    });
  });
});
