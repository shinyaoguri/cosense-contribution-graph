import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AUTH_OPENER_ORIGIN, parseAuthCode } from "../../src/shared/auth.ts";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { buildEnrollUrl } from "../../src/shared/enroll.ts";
import { sha256Hex } from "../../src/shared/hash.ts";
import {
  type AuthDeps,
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  handleAuthCallback,
  handleAuthStart,
} from "../../src/worker/auth.ts";
import { AUTH_COOKIE_NAME, openAuthCookie } from "../../src/worker/auth-cookie.ts";
import { AUTH_PAGE_SCRIPT, AUTH_PAGE_STYLE } from "../../src/worker/auth-page.ts";
import { handleEnroll } from "../../src/worker/enroll.ts";
import { googleKeys } from "../../src/worker/idtoken.ts";
import { uidOf } from "../../src/worker/uid.ts";
import { createSigner, gifWidth } from "./beacon-helpers.ts";
import {
  CLIENT_ID,
  createSigningKey,
  jwksServer,
  NOW_MS,
  type SigningKey,
  SUB,
  signToken,
  validClaims,
} from "./idtoken-helpers.ts";

const ORIGIN = "https://grass.soui.dev";
const SECRET = "test-worker-secret";
const CLIENT_SECRET = "test-google-client-secret";

let googleKey: SigningKey;

beforeAll(async () => {
  googleKey = await createSigningKey("kid-google");
});

afterEach(() => {
  vi.restoreAllMocks();
});

type TokenCall = {
  url: string;
  method: string | undefined;
  contentType: string | null;
  body: URLSearchParams;
};

/** トークンエンドポイントの代わり。`respond` で応答を差し替える */
function tokenServer(respond: (body: URLSearchParams) => Promise<Response> | Response) {
  const calls: TokenCall[] = [];
  return {
    calls,
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      const body = new URLSearchParams(String(init.body));
      calls.push({
        url,
        method: init.method,
        contentType: new Headers(init.headers).get("content-type"),
        body,
      });
      return respond(body);
    },
  };
}

function setup(
  options: {
    respond?: (session: { nonce: string }) => Promise<Response> | Response;
    db?: D1Database;
  } = {},
) {
  const clock = { ms: NOW_MS };
  const jwks = jwksServer([googleKey]);
  let nonce = "";
  const token = tokenServer(async () =>
    options.respond
      ? options.respond({ nonce })
      : Response.json({ id_token: await signToken(googleKey, validClaims({ nonce })) }),
  );
  const deps: AuthDeps = {
    db: options.db ?? env.DB,
    secret: SECRET,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    publicOrigin: ORIGIN,
    keys: googleKeys({ fetch: jwks.fetch, now: () => clock.ms }),
    fetch: token.fetch,
    now: () => clock.ms,
  };

  /** start を通し、Google から戻ってきた callback の URL と cookie を作る */
  async function signIn(query: Record<string, string> = { code: "4/0AQ-test-code" }) {
    const started = await handleAuthStart(new URL(`${ORIGIN}/auth/start`), deps);
    const setCookie = started.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0] ?? "";
    const location = new URL(started.headers.get("location") ?? "");
    nonce = location.searchParams.get("nonce") ?? "";
    const callback = new URL(`${ORIGIN}/auth/callback`);
    callback.searchParams.set("state", location.searchParams.get("state") ?? "");
    for (const [key, value] of Object.entries(query)) {
      callback.searchParams.set(key, value);
    }
    return { started, setCookie, cookie, location, callback };
  }

  return { deps, clock, jwks, token, signIn };
}

async function enrollTokenCount(uid: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM enroll_tokens WHERE uid = ?")
    .bind(uid)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function codeFrom(html: string): string {
  return /data-code="([^"]+)"/.exec(html)?.[1] ?? "";
}

describe("GET /auth/start", () => {
  it("**Google の認可エンドポイントへ 302 し、クエリはちょうど 9 個**", async () => {
    const { signIn } = setup();
    const { started, location } = await signIn();

    expect(started.status).toBe(302);
    expect(`${location.origin}${location.pathname}`).toBe(GOOGLE_AUTH_URL);
    expect([...location.searchParams.keys()].sort()).toEqual(
      [
        "client_id",
        "code_challenge",
        "code_challenge_method",
        "nonce",
        "prompt",
        "redirect_uri",
        "response_type",
        "scope",
        "state",
      ].sort(),
    );
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: `${ORIGIN}/auth/callback`,
      response_type: "code",
      scope: "openid",
      code_challenge_method: "S256",
      prompt: "select_account",
    });
  });

  it("**state・nonce・code_challenge が cookie の中身と対応する**", async () => {
    const { signIn } = setup();
    const { cookie, location } = await signIn();
    const opened = await openAuthCookie(SECRET, cookie, NOW_MS);
    if (!opened.ok) {
      throw new Error(opened.reason);
    }
    const { session } = opened;
    expect(location.searchParams.get("state")).toBe(encodeBase64url(session.state));
    expect(location.searchParams.get("nonce")).toBe(encodeBase64url(session.nonce));
    const challenge = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(encodeBase64url(session.verifier)),
    );
    expect(location.searchParams.get("code_challenge")).toBe(
      encodeBase64url(new Uint8Array(challenge)),
    );
  });

  it("**302 はキャッシュさせず、Referer を Google に渡さない**", async () => {
    const { started, setCookie } = await setup().signIn();
    expect(started.headers.get("cache-control")).toBe("no-store");
    expect(started.headers.get("referrer-policy")).toBe("no-referrer");
    expect(setCookie.startsWith(`${AUTH_COOKIE_NAME}=`)).toBe(true);
  });

  it("呼ぶたびに state が変わる", async () => {
    const { signIn } = setup();
    const a = await signIn();
    const b = await signIn();
    expect(a.location.searchParams.get("state")).not.toBe(b.location.searchParams.get("state"));
  });

  it("**別のホストでは PUBLIC_ORIGIN の /auth/start へ 302 し、cookie もクエリも付けない**", async () => {
    const { deps } = setup();
    const res = await handleAuthStart(
      new URL("https://cosense-grass.soui.workers.dev/auth/start?return_to=https://evil.example"),
      deps,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/auth/start`);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("設定が欠けていたら 500", async () => {
    const { deps } = setup();
    for (const broken of [
      { ...deps, clientSecret: "" },
      { ...deps, clientId: "" },
      { ...deps, publicOrigin: `${ORIGIN}/` },
    ]) {
      const res = await handleAuthStart(new URL(`${ORIGIN}/auth/start`), broken);
      expect(res.status).toBe(500);
    }
  });
});

describe("GET /auth/callback — 成功", () => {
  it("**コードを交換して登録トークンを発行し、そのコードで端末を登録できる**", async () => {
    const { deps, signIn, token } = setup();
    const { callback, cookie } = await signIn();
    const uid = await uidOf(SECRET, SUB);
    const before = await enrollTokenCount(uid);

    const res = await handleAuthCallback(callback, cookie, deps);
    expect(res.status).toBe(200);

    expect(token.calls).toHaveLength(1);
    const [call] = token.calls;
    expect(call?.url).toBe(GOOGLE_TOKEN_URL);
    expect(call?.method).toBe("POST");
    expect(call?.contentType).toBe("application/x-www-form-urlencoded");
    const opened = await openAuthCookie(SECRET, cookie, NOW_MS);
    expect(Object.fromEntries(call?.body ?? [])).toEqual({
      code: "4/0AQ-test-code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: `${ORIGIN}/auth/callback`,
      grant_type: "authorization_code",
      code_verifier: opened.ok ? encodeBase64url(opened.session.verifier) : "",
    });
    expect(await enrollTokenCount(uid)).toBe(before + 1);

    // 表示されたコードで、新しい端末の鍵を登録する (callback から登録まで)
    const code = parseAuthCode(codeFrom(await res.text()));
    expect(code?.uid).toBe(uid);
    const signer = await createSigner();
    const enrollUrl = await buildEnrollUrl(
      ORIGIN,
      { uid, publicKey: signer.publicKey, token: code?.token ?? "" },
      signer.sign,
    );
    const enrolled = await handleEnroll(new URL(enrollUrl), { db: env.DB, now: () => NOW_MS });
    expect(enrolled.status).toBe(200);
    expect(await gifWidth(enrolled)).toBe(17);
  });

  it("**HTML は scrapbox.io だけに postMessage し、COOP を付けず、CSP のハッシュが中身と一致する**", async () => {
    const { deps, signIn } = setup();
    const { callback, cookie } = await signIn();
    const res = await handleAuthCallback(callback, cookie, deps);
    const html = await res.text();

    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    expect(script).toBe(AUTH_PAGE_SCRIPT);
    expect(style).toBe(AUTH_PAGE_STYLE);
    expect(script).toContain(`postMessage(message, ${JSON.stringify(AUTH_OPENER_ORIGIN)})`);
    expect(script).not.toContain('"*"');

    const csp = res.headers.get("content-security-policy") ?? "";
    const hash = async (text: string) =>
      `sha256-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))))}`;
    expect(csp).toContain(`script-src '${await hash(script)}'`);
    expect(csp).toContain(`style-src '${await hash(style)}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("**成功しても cookie を消す**", async () => {
    const { deps, signIn } = setup();
    const { callback, cookie } = await signIn();
    const res = await handleAuthCallback(callback, cookie, deps);
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^${AUTH_COOKIE_NAME}=; Max-Age=0;`));
  });
});

describe("GET /auth/callback — Google に問い合わせる前に止める", () => {
  async function expectRejected(res: Response, status: number, error: string, fetchCalls: number) {
    expect(res.status).toBe(status);
    expect(fetchCalls).toBe(0);
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    const html = await res.text();
    expect(html).toContain(`data-error="${error}"`);
    expect(html).not.toContain("data-code");
  }

  it("cookie が無ければ 400", async () => {
    const { deps, signIn, token } = setup();
    const { callback } = await signIn();
    await expectRejected(
      await handleAuthCallback(callback, null, deps),
      400,
      "expired",
      token.calls.length,
    );
  });

  it("**cookie を書き換えたら 403**", async () => {
    const { deps, signIn, token } = setup();
    const { callback, cookie } = await signIn();
    const tampered = `${cookie.slice(0, -2)}${cookie.endsWith("AA") ? "BA" : "AA"}`;
    await expectRejected(
      await handleAuthCallback(callback, tampered, deps),
      403,
      "expired",
      token.calls.length,
    );
  });

  it("cookie が期限切れなら 400", async () => {
    const { deps, signIn, token, clock } = setup();
    const { callback, cookie } = await signIn();
    clock.ms += 601_000;
    await expectRejected(
      await handleAuthCallback(callback, cookie, deps),
      400,
      "expired",
      token.calls.length,
    );
  });

  it("**state が違う・無い・2 つあるなら 403** (別のサインインの cookie と組み合わせさせない)", async () => {
    const { deps, signIn, token } = setup();
    const first = await signIn();
    const second = await signIn();
    // 先に始めたサインインの state と、後から始めたサインインの cookie
    await expectRejected(
      await handleAuthCallback(first.callback, second.cookie, deps),
      403,
      "expired",
      token.calls.length,
    );

    const missing = new URL(first.callback);
    missing.searchParams.delete("state");
    await expectRejected(
      await handleAuthCallback(missing, first.cookie, deps),
      403,
      "expired",
      token.calls.length,
    );

    const doubled = new URL(first.callback);
    doubled.searchParams.append("state", first.callback.searchParams.get("state") ?? "");
    await expectRejected(
      await handleAuthCallback(doubled, first.cookie, deps),
      403,
      "expired",
      token.calls.length,
    );
  });

  it("**取り消し (error=access_denied) は 400 で cancelled。error_description を反射しない**", async () => {
    const { deps, signIn, token } = setup();
    const { callback, cookie } = await signIn({
      error: "access_denied",
      error_description: "<script>alert(1)</script>",
    });
    const res = await handleAuthCallback(callback, cookie, deps);
    const html = await res.clone().text();
    expect(html).not.toContain("alert(1)");
    await expectRejected(res, 400, "cancelled", token.calls.length);
  });

  it("それ以外の error は 400 で failed", async () => {
    const { deps, signIn, token } = setup();
    const { callback, cookie } = await signIn({ error: "server_error" });
    await expectRejected(
      await handleAuthCallback(callback, cookie, deps),
      400,
      "failed",
      token.calls.length,
    );
  });

  it("code が無い・長すぎるなら 400", async () => {
    const { deps, signIn, token } = setup();
    const missing = await signIn({});
    await expectRejected(
      await handleAuthCallback(missing.callback, missing.cookie, deps),
      400,
      "failed",
      token.calls.length,
    );
    const long = await signIn({ code: "x".repeat(513) });
    await expectRejected(
      await handleAuthCallback(long.callback, long.cookie, deps),
      400,
      "failed",
      token.calls.length,
    );
  });

  it("**別のホストの callback は 404** (postMessage の送り元を 1 つに揃える)", async () => {
    const { deps, signIn, token } = setup();
    const { callback, cookie } = await signIn();
    const other = new URL(
      callback.pathname + callback.search,
      "https://cosense-grass.soui.workers.dev",
    );
    const res = await handleAuthCallback(other, cookie, deps);
    expect(res.status).toBe(404);
    expect(token.calls).toHaveLength(0);
  });
});

describe("GET /auth/callback — Google 側の失敗", () => {
  it.each([
    [
      "トークンエンドポイントが 400 (code の使い回し)",
      () => Response.json({ error: "invalid_grant" }, { status: 400 }),
      400,
    ],
    ["トークンエンドポイントが 500", () => new Response("oops", { status: 500 }), 502],
    ["通信に失敗", () => Promise.reject(new Error("network")), 502],
    ["JSON でない", () => new Response("not json"), 502],
    ["id_token が無い", () => Response.json({ access_token: "x" }), 502],
  ])("%s なら %s で、登録トークンを発行しない", async (_, respond, status) => {
    const { deps, signIn } = setup({ respond });
    const { callback, cookie } = await signIn();
    const uid = await uidOf(SECRET, SUB);
    const before = await enrollTokenCount(uid);

    const res = await handleAuthCallback(callback, cookie, deps);
    expect(res.status).toBe(status);
    expect(await res.text()).toContain('data-error="failed"');
    expect(await enrollTokenCount(uid)).toBe(before);
  });

  it.each([
    ["**nonce が違う**", { nonce: "other-nonce" }],
    ["aud が別のクライアント", { aud: "other.apps.googleusercontent.com" }],
  ])("ID トークンの %s なら 403 で、登録トークンを発行しない", async (_, overrides) => {
    const { deps, signIn } = setup({
      respond: async ({ nonce }) =>
        Response.json({
          id_token: await signToken(googleKey, validClaims({ nonce, ...overrides })),
        }),
    });
    const { callback, cookie } = await signIn();
    const uid = await uidOf(SECRET, SUB);
    const before = await enrollTokenCount(uid);

    const res = await handleAuthCallback(callback, cookie, deps);
    expect(res.status).toBe(403);
    expect(await enrollTokenCount(uid)).toBe(before);
  });

  it("JWKS が取れなければ 502", async () => {
    const { deps, signIn, jwks } = setup();
    jwks.status = 500;
    const { callback, cookie } = await signIn();
    expect((await handleAuthCallback(callback, cookie, deps)).status).toBe(502);
  });

  it("D1 が throw したら 500", async () => {
    const failing = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return () => {
            throw new Error("D1_ERROR");
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { deps, signIn } = setup({ db: failing });
    const { callback, cookie } = await signIn();
    expect((await handleAuthCallback(callback, cookie, deps)).status).toBe(500);
  });
});

describe("ログ", () => {
  it("**1 リクエスト 1 行で、code・state・cookie・ID トークン・sub・uid・トークン・secret を出さない**", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });
    let idToken = "";
    const { deps, signIn } = setup({
      respond: async ({ nonce }) => {
        idToken = await signToken(googleKey, validClaims({ nonce }));
        return Response.json({ id_token: idToken });
      },
    });
    const { callback, cookie } = await signIn();
    const res = await handleAuthCallback(callback, cookie, deps);
    const code = parseAuthCode(codeFrom(await res.text()));

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { event: "auth", step: "start", status: 302, reason: "redirect" },
      { event: "auth", step: "callback", status: 200, reason: "issued" },
    ]);
    const secrets = [
      "4/0AQ-test-code",
      callback.searchParams.get("state") ?? "",
      cookie.slice(AUTH_COOKIE_NAME.length + 1),
      idToken,
      SUB,
      code?.uid ?? "",
      code?.token ?? "",
      await sha256Hex(code?.token ?? ""),
      SECRET,
      CLIENT_SECRET,
    ];
    for (const line of lines) {
      for (const secret of secrets) {
        expect(secret).not.toBe("");
        expect(line).not.toContain(secret);
      }
    }
  });

  it("ID トークンの拒否理由は detail に出す", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });
    const { deps, signIn } = setup({
      respond: async () =>
        Response.json({ id_token: await signToken(googleKey, validClaims({ nonce: "x" })) }),
    });
    const { callback, cookie } = await signIn();
    await handleAuthCallback(callback, cookie, deps);
    expect(JSON.parse(lines.at(-1) ?? "")).toEqual({
      event: "auth",
      step: "callback",
      status: 403,
      reason: "idtoken",
      detail: "nonce",
    });
  });
});

describe("経路", () => {
  it("**/auth/start は 302 で cookie を付ける** (Google へは辿らない)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/auth/start`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")?.startsWith(GOOGLE_AUTH_URL)).toBe(true);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("client_id")).toBe(
      env.GOOGLE_CLIENT_ID,
    );
    expect(res.headers.get("set-cookie")?.startsWith(`${AUTH_COOKIE_NAME}=`)).toBe(true);
  });

  it("別のホストの /auth/start は grass.soui.dev へ 302", async () => {
    const res = await SELF.fetch("https://example.com/auth/start", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/auth/start`);
  });

  it("cookie の無い callback は 400 の HTML", async () => {
    const res = await SELF.fetch(`${ORIGIN}/auth/callback?state=x&code=y`, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it.each(["HEAD", "POST"])("**%s は 404** (code を交換させない)", async (method) => {
    for (const path of ["/auth/start", "/auth/callback"]) {
      const res = await SELF.fetch(`${ORIGIN}${path}`, { method, redirect: "manual" });
      expect(res.status, path).toBe(404);
    }
  });
});
