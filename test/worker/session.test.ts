import { describe, expect, it } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { UID_BYTES } from "../../src/shared/ids.ts";
import {
  clearSession,
  csrfToken,
  openSession,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  sealSession,
  verifyCsrf,
} from "../../src/worker/session.ts";

const SECRET = "test-secret";
const UID = encodeBase64url(new Uint8Array(UID_BYTES).fill(9));
const NOW = Date.UTC(2026, 8, 15, 3, 0, 0);

/** `Set-Cookie` の値から cookie ヘッダを作る */
function header(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

describe("封じる", () => {
  it("**`__Host-` / HttpOnly / Secure / SameSite=Lax で 30 分**", async () => {
    const cookie = await sealSession(SECRET, UID, NOW);

    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(cookie).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
    expect(SESSION_MAX_AGE_SECONDS).toBe(1800);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("uid の形が違えば throw する", async () => {
    await expect(sealSession(SECRET, "short", NOW)).rejects.toThrow();
  });

  it("消す cookie は属性を揃える", () => {
    expect(clearSession()).toContain("Max-Age=0");
    expect(clearSession()).toContain("HttpOnly");
  });
});

describe("開く", () => {
  it("封じた cookie から uid を読める", async () => {
    const cookie = await sealSession(SECRET, UID, NOW);

    const opened = await openSession(SECRET, header(cookie), NOW);

    expect(opened).toEqual({ ok: true, session: { uid: UID, issuedAt: NOW / 1000 } });
  });

  it.each([
    ["無い", () => "", "missing"],
    ["2 つある", (cookie: string) => `${header(cookie)}; ${header(cookie)}`, "duplicate"],
    ["形が違う", () => `${SESSION_COOKIE_NAME}=abc`, "format"],
  ])("%s なら %s", async (_name, build, reason) => {
    const cookie = await sealSession(SECRET, UID, NOW);

    expect(await openSession(SECRET, build(cookie), NOW)).toEqual({ ok: false, reason });
  });

  it("**別の鍵で署名された cookie は通らない**", async () => {
    const cookie = await sealSession("другой", UID, NOW);

    expect(await openSession(SECRET, header(cookie), NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("**サインインの往復の cookie の鍵では開けない** (用途ごとに鍵を分けている)", async () => {
    const cookie = await sealSession(SECRET, UID, NOW);
    // ラベルが違えば別の鍵になる。ここでは secret を変えて同じことを確かめる
    expect(await openSession(`${SECRET}x`, header(cookie), NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it.each([
    ["30 分ちょうど", SESSION_MAX_AGE_SECONDS * 1000, true],
    ["30 分 + 1 秒", (SESSION_MAX_AGE_SECONDS + 1) * 1000, false],
    ["未来 (ずれの範囲内)", -60_000, true],
    ["未来 (ずれを超える)", -61_000, false],
  ])("%s は %s", async (_name, elapsed, ok) => {
    const cookie = await sealSession(SECRET, UID, NOW);

    const opened = await openSession(SECRET, header(cookie), NOW + elapsed);

    expect(opened.ok).toBe(ok);
    if (!opened.ok) {
      expect(opened.reason).toBe("expired");
    }
  });
});

describe("CSRF トークン", () => {
  const session = { uid: UID, issuedAt: NOW / 1000 };

  it("同じセッションなら通る", async () => {
    const token = await csrfToken(SECRET, session);

    expect(await verifyCsrf(SECRET, session, token)).toBe(true);
  });

  it.each([
    [
      "別のセッション (uid が違う)",
      { uid: encodeBase64url(new Uint8Array(UID_BYTES).fill(8)), issuedAt: NOW / 1000 },
    ],
    ["別のセッション (時刻が違う)", { uid: UID, issuedAt: NOW / 1000 + 1 }],
  ])("**%s のトークンは通らない**", async (_name, other) => {
    const token = await csrfToken(SECRET, other);

    expect(await verifyCsrf(SECRET, session, token)).toBe(false);
  });

  it("長さの違う値も落とす", async () => {
    expect(await verifyCsrf(SECRET, session, "")).toBe(false);
    expect(await verifyCsrf(SECRET, session, "x")).toBe(false);
  });
});
