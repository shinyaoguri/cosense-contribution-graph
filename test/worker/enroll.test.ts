import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { buildEnrollUrl, ENROLL_PARAM } from "../../src/shared/enroll.ts";
import { sha256Hex } from "../../src/shared/hash.ts";
import { PH_ALL, publicIdOf } from "../../src/shared/ids.ts";
import {
  ENROLL_TOKEN_TTL_SECONDS,
  handleEnroll,
  issueEnrollToken,
} from "../../src/worker/enroll.ts";
import { createSigner, entry, gifWidth, NOW, randomUid, type Signer } from "./beacon-helpers.ts";

const ORIGIN = "https://example.com";

afterEach(() => {
  vi.restoreAllMocks();
});

function enrollUrl(signer: Signer, uid: string, token: string): Promise<URL> {
  return buildEnrollUrl(ORIGIN, { uid, publicKey: signer.publicKey, token }, signer.sign).then(
    (href) => new URL(href),
  );
}

function enroll(url: URL, nowMs = NOW, db: D1Database = env.DB): Promise<Response> {
  return handleEnroll(url, { db, now: () => nowMs });
}

async function keyRows(uid: string) {
  const { results } = await env.DB.prepare("SELECT kid, pubkey, created FROM keys WHERE uid = ?")
    .bind(uid)
    .all<{ kid: string; pubkey: ArrayBuffer; created: number }>();
  return results;
}

async function tokenCount(token: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM enroll_tokens WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** D1 の呼び出しを数える。触ったら throw する D1 */
function untouchableDb(): D1Database {
  return new Proxy(env.DB, {
    get() {
      throw new Error("D1 に触った");
    },
  });
}

describe("issueEnrollToken", () => {
  it("**22 文字のトークンを返し、D1 にはそのハッシュだけを書く**", async () => {
    const uid = randomUid();
    const { token, expires } = await issueEnrollToken(env.DB, uid, NOW);

    expect(token).toHaveLength(22);
    expect(expires).toBe(NOW / 1000 + ENROLL_TOKEN_TTL_SECONDS);
    const { results } = await env.DB.prepare(
      "SELECT token_hash, uid, expires FROM enroll_tokens WHERE uid = ?",
    )
      .bind(uid)
      .all<{ token_hash: string; uid: string; expires: number }>();
    expect(results).toEqual([{ token_hash: await sha256Hex(token), uid, expires }]);
    expect(JSON.stringify(results)).not.toContain(token);
  });

  it("uid の形が違えば例外", async () => {
    await expect(issueEnrollToken(env.DB, "short", NOW)).rejects.toThrow(RangeError);
  });
});

describe("handleEnroll", () => {
  it("**登録する: keys と全体用の graphs ができ、トークンが消える**", async () => {
    const signer = await createSigner();
    const uid = randomUid();
    const { token } = await issueEnrollToken(env.DB, uid, NOW);

    const res = await enroll(await enrollUrl(signer, uid, token));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await gifWidth(res)).toBe(17);

    const rows = await keyRows(uid);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kid).toBe(signer.kid);
    expect([...new Uint8Array(rows[0]?.pubkey ?? new ArrayBuffer(0))]).toEqual([
      ...signer.publicKey,
    ]);
    expect(rows[0]?.created).toBe(NOW / 1000);

    const graph = await env.DB.prepare("SELECT uid, ph FROM graphs WHERE public_id = ?")
      .bind(await publicIdOf(uid, PH_ALL))
      .first();
    expect(graph).toEqual({ uid, ph: PH_ALL });
    expect(await tokenCount(token)).toBe(0);
  });

  it("**同じトークンの 2 回目は 403** で、何も増えない", async () => {
    const signer = await createSigner();
    const uid = randomUid();
    const { token } = await issueEnrollToken(env.DB, uid, NOW);
    const url = await enrollUrl(signer, uid, token);

    expect((await enroll(url)).status).toBe(200);
    expect((await enroll(url)).status).toBe(403);
    expect(await keyRows(uid)).toHaveLength(1);
  });

  it("**同時に 2 回送っても、通るのはちょうど 1 回**", async () => {
    const uid = randomUid();
    const { token } = await issueEnrollToken(env.DB, uid, NOW);
    const [a, b] = await Promise.all([createSigner(), createSigner()]);
    const urls = await Promise.all([enrollUrl(a, uid, token), enrollUrl(b, uid, token)]);

    const statuses = (await Promise.all(urls.map((url) => enroll(url)))).map((res) => res.status);
    expect(statuses.sort()).toEqual([200, 403]);
    expect(await keyRows(uid)).toHaveLength(1);
  });

  it(`**発行から ${ENROLL_TOKEN_TTL_SECONDS} 秒までは通り、それを過ぎたら 403。期限切れでもトークンは消える**`, async () => {
    const signer = await createSigner();
    const uid = randomUid();
    const edge = await issueEnrollToken(env.DB, uid, NOW);
    const late = await issueEnrollToken(env.DB, uid, NOW);

    const lateRes = await enroll(
      await enrollUrl(signer, uid, late.token),
      NOW + (ENROLL_TOKEN_TTL_SECONDS + 1) * 1000,
    );
    expect(lateRes.status).toBe(403);
    expect(await tokenCount(late.token)).toBe(0);
    expect(await keyRows(uid)).toHaveLength(0);

    const edgeRes = await enroll(
      await enrollUrl(signer, uid, edge.token),
      NOW + ENROLL_TOKEN_TTL_SECONDS * 1000,
    );
    expect(edgeRes.status).toBe(200);
  });

  it("知らないトークンは 403 で、何も書かない", async () => {
    const signer = await createSigner();
    const uid = randomUid();
    const token = encodeBase64url(crypto.getRandomValues(new Uint8Array(16)));

    expect((await enroll(await enrollUrl(signer, uid, token))).status).toBe(403);
    expect(await keyRows(uid)).toHaveLength(0);
  });

  it("**別の uid のトークンは 403。そのトークンは燃え、正しい uid で送り直しても通らない**", async () => {
    const signer = await createSigner();
    const owner = randomUid();
    const attacker = randomUid();
    const { token } = await issueEnrollToken(env.DB, owner, NOW);

    expect((await enroll(await enrollUrl(signer, attacker, token))).status).toBe(403);
    expect(await keyRows(attacker)).toHaveLength(0);
    expect((await enroll(await enrollUrl(signer, owner, token))).status).toBe(403);
    expect(await keyRows(owner)).toHaveLength(0);
  });

  it("**署名が違えば 403 で D1 に触らない。トークンは残り、正しい署名なら同じトークンで通る**", async () => {
    const signer = await createSigner();
    const other = await createSigner();
    const uid = randomUid();
    const { token } = await issueEnrollToken(env.DB, uid, NOW);

    // 登録する公開鍵と違う鍵で署名する (秘密鍵と公開鍵の取り違え)
    const forged = new URL(
      await buildEnrollUrl(ORIGIN, { uid, publicKey: signer.publicKey, token }, other.sign),
    );
    expect((await enroll(forged, NOW, untouchableDb())).status).toBe(403);
    expect(await tokenCount(token)).toBe(1);

    expect((await enroll(await enrollUrl(signer, uid, token))).status).toBe(200);
  });

  it("曲線上に無い公開鍵は 400 で、D1 に触らない", async () => {
    const signer = await createSigner();
    const url = await enrollUrl(signer, randomUid(), encodeBase64url(new Uint8Array(16)));
    const bogus = new Uint8Array(65).fill(9);
    bogus[0] = 4;
    url.searchParams.set(ENROLL_PARAM.publicKey, encodeBase64url(bogus));

    expect((await enroll(url, NOW, untouchableDb())).status).toBe(400);
  });

  it("形の違うクエリは 400 で、D1 に触らない", async () => {
    const res = await enroll(new URL(`${ORIGIN}/v1/enroll.gif?v=1&u=x`), NOW, untouchableDb());
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("**登録済みの鍵を新しいトークンで送ると 200 で幅 16** (created は最初の登録のまま)", async () => {
    const signer = await createSigner();
    const uid = randomUid();
    const first = await issueEnrollToken(env.DB, uid, NOW);
    await enroll(await enrollUrl(signer, uid, first.token));
    const second = await issueEnrollToken(env.DB, uid, NOW + 60_000);

    const res = await enroll(await enrollUrl(signer, uid, second.token), NOW + 60_000);
    expect(res.status).toBe(200);
    expect(await gifWidth(res)).toBe(16);
    expect((await keyRows(uid)).map((row) => row.created)).toEqual([NOW / 1000]);
  });

  it("2 台目の鍵も同じ uid に登録でき、graphs は 1 行のまま", async () => {
    const uid = randomUid();
    for (const signer of [await createSigner(), await createSigner()]) {
      const { token } = await issueEnrollToken(env.DB, uid, NOW);
      expect((await enroll(await enrollUrl(signer, uid, token))).status).toBe(200);
    }
    expect(await keyRows(uid)).toHaveLength(2);
    const graphs = await env.DB.prepare("SELECT count(*) AS n FROM graphs WHERE uid = ?")
      .bind(uid)
      .first();
    expect(graphs).toEqual({ n: 1 });
  });

  it("D1 が throw したら 500", async () => {
    const signer = await createSigner();
    const uid = randomUid();
    const { token } = await issueEnrollToken(env.DB, uid, NOW);
    const failing = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") {
          return () => Promise.reject(new Error("D1_ERROR"));
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const res = await enroll(await enrollUrl(signer, uid, token), NOW, failing);
    expect(res.status).toBe(500);
    expect(await tokenCount(token)).toBe(1);
  });

  it("**ログは 1 行で、uid・kid・トークン・そのハッシュを出さない**", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });
    const signer = await createSigner();
    const uid = randomUid();
    const { token } = await issueEnrollToken(env.DB, uid, NOW);
    const url = await enrollUrl(signer, uid, token);
    await enroll(url);
    await enroll(url);

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { event: "enroll", status: 200, reason: "added" },
      { event: "enroll", status: 403, reason: "unknown-token" },
    ]);
    const hash = await sha256Hex(token);
    for (const line of lines) {
      for (const secret of [uid, signer.kid, token, hash]) {
        expect(line).not.toContain(secret);
      }
    }
  });
});

describe("経路", () => {
  it("**登録した鍵で署名した記録が 200 になる** (登録から記録まで)", async () => {
    const signer = await createSigner();
    const uid = randomUid();
    const { token } = await issueEnrollToken(env.DB, uid, Date.now());

    const enrolled = await SELF.fetch((await enrollUrl(signer, uid, token)).href);
    expect(enrolled.status).toBe(200);

    const today = new Date().toISOString().slice(0, 10);
    const beacon = await signer.url(uid, [entry({ day: today })], Math.floor(Date.now() / 1000));
    const recorded = await SELF.fetch(beacon.href);
    expect(recorded.status).toBe(200);
  });

  it("**HEAD ではトークンを消費させない** (404)", async () => {
    const signer = await createSigner();
    const uid = randomUid();
    const { token } = await issueEnrollToken(env.DB, uid, Date.now());

    const res = await SELF.fetch((await enrollUrl(signer, uid, token)).href, { method: "HEAD" });
    expect(res.status).toBe(404);
    expect(await tokenCount(token)).toBe(1);
  });

  it("形の違うクエリは 400", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/enroll.gif?v=1&u=x`);
    expect(res.status).toBe(400);
  });
});
