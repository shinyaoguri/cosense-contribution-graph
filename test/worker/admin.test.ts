import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bitmapOf } from "../../src/shared/bits.ts";
import { sha256Hex } from "../../src/shared/hash.ts";
import { PH_ALL, publicIdOf } from "../../src/shared/ids.ts";
import { buildPurgeUrl, PURGE_PARAM, PURGE_PATH } from "../../src/shared/purge.ts";
import { handlePurge } from "../../src/worker/admin.ts";
import { createSigner, gifWidth, NOW, randomUid, type Signer, TODAY } from "./beacon-helpers.ts";

const ORIGIN = "https://example.com";

const NOW_SECONDS = NOW / 1000;

function purgeUrl(signer: Signer, uid: string, time = NOW_SECONDS): Promise<URL> {
  return buildPurgeUrl(ORIGIN, { uid, kid: signer.kid, time }, signer.sign).then(
    (href) => new URL(href),
  );
}

function purge(url: URL, signer: Signer, nowMs = NOW, db: D1Database = env.DB): Promise<Response> {
  return handlePurge(url, { db, resolveKey: signer.resolveKey, now: () => nowMs });
}

/** 5 つの表すべてにその uid の行を入れる。 */
async function seed(uid: string, signer: Signer): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO keys (uid, kid, pubkey, created) VALUES (?, ?, ?, ?)").bind(
      uid,
      signer.kid,
      signer.publicKey,
      NOW_SECONDS,
    ),
    env.DB.prepare("INSERT INTO graphs (public_id, uid, ph) VALUES (?, ?, ?)").bind(
      await publicIdOf(uid, PH_ALL),
      uid,
      PH_ALL,
    ),
    env.DB.prepare(
      "INSERT INTO daily (uid, ph, day, w, r, pages, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(uid, PH_ALL, TODAY, 3, 1, 2, 1),
    env.DB.prepare("INSERT INTO daybits (uid, ph, day, wbits, rbits) VALUES (?, ?, ?, ?, ?)").bind(
      uid,
      PH_ALL,
      TODAY,
      bitmapOf([1]),
      bitmapOf([2]),
    ),
    env.DB.prepare("INSERT INTO enroll_tokens (token_hash, uid, expires) VALUES (?, ?, ?)").bind(
      await sha256Hex(`token-${uid}`),
      uid,
      NOW_SECONDS + 300,
    ),
  ]);
}

/** 5 つの表に残っている行の合計。 */
async function rowCount(uid: string): Promise<number> {
  const tables = ["keys", "graphs", "daily", "daybits", "enroll_tokens"];
  let total = 0;
  for (const table of tables) {
    const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE uid = ?`)
      .bind(uid)
      .first<{ n: number }>();
    total += row?.n ?? 0;
  }
  return total;
}

/** 触ったら throw する D1 (enroll.test.ts と同じ)。 */
function untouchableDb(): D1Database {
  return new Proxy(env.DB, {
    get() {
      throw new Error("D1 に触った");
    },
  });
}

describe("全データの削除", () => {
  it("**5 つの表からその uid の行を全部消し、幅 17 を返す**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await seed(uid, signer);
    expect(await rowCount(uid)).toBe(5);

    const res = await purge(await purgeUrl(signer, uid), signer);

    expect(res.status).toBe(200);
    expect(await gifWidth(res)).toBe(17);
    expect(await rowCount(uid)).toBe(0);
  });

  it("**ほかの uid の行は消さない**", async () => {
    const uid = randomUid();
    const other = randomUid();
    const signer = await createSigner();
    const otherSigner = await createSigner();
    await seed(uid, signer);
    await seed(other, otherSigner);

    await purge(await purgeUrl(signer, uid), signer);

    expect(await rowCount(other)).toBe(5);
  });

  it("消すものが無ければ幅 16 (それでも 200)", async () => {
    const uid = randomUid();
    const signer = await createSigner();

    const res = await purge(await purgeUrl(signer, uid), signer);

    expect(res.status).toBe(200);
    expect(await gifWidth(res)).toBe(16);
  });
});

describe("断る", () => {
  it("**`confirm=1` が無ければ 400。D1 に触らない**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    const url = await purgeUrl(signer, uid);
    url.searchParams.set(PURGE_PARAM.confirm, "0");

    const res = await purge(url, signer, NOW, untouchableDb());

    expect(res.status).toBe(400);
  });

  it("**60 秒の窓の外なら 403。何も消えない**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await seed(uid, signer);

    const res = await purge(await purgeUrl(signer, uid, NOW_SECONDS - 61), signer);

    expect(res.status).toBe(403);
    expect(await rowCount(uid)).toBe(5);
  });

  it("**署名した鍵が登録されていなければ 403。何も消えない**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await seed(uid, signer);

    const res = await handlePurge(await purgeUrl(signer, uid), {
      db: env.DB,
      resolveKey: async () => undefined,
      now: () => NOW,
    });

    expect(res.status).toBe(403);
    expect(await rowCount(uid)).toBe(5);
  });

  it("**署名が合わなければ 403。何も消えない**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    const impostor = await createSigner();
    await seed(uid, signer);
    const url = await purgeUrl(signer, uid);
    const forged = await purgeUrl(impostor, uid);
    url.searchParams.set(
      PURGE_PARAM.signature,
      forged.searchParams.get(PURGE_PARAM.signature) ?? "",
    );

    const res = await purge(url, signer);

    expect(res.status).toBe(403);
    expect(await rowCount(uid)).toBe(5);
  });

  it("**2 回目は 403** (鍵も消えているので署名する鍵を引けない)", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await seed(uid, signer);
    // 1 回目は消える。2 回目は D1 の keys から引くので見つからない
    await handlePurge(await purgeUrl(signer, uid), {
      db: env.DB,
      resolveKey: async (_uid, kid) =>
        (await env.DB.prepare("SELECT 1 AS ok FROM keys WHERE uid = ? AND kid = ?")
          .bind(uid, kid)
          .first()) === null
          ? undefined
          : signer.resolveKey(uid, kid),
      now: () => NOW,
    });

    const res = await handlePurge(await purgeUrl(signer, uid), {
      db: env.DB,
      resolveKey: async (_uid, kid) =>
        (await env.DB.prepare("SELECT 1 AS ok FROM keys WHERE uid = ? AND kid = ?")
          .bind(uid, kid)
          .first()) === null
          ? undefined
          : signer.resolveKey(uid, kid),
      now: () => NOW,
    });

    expect(res.status).toBe(403);
  });

  it("D1 が失敗したら 500", async () => {
    const uid = randomUid();
    const signer = await createSigner();

    const res = await handlePurge(await purgeUrl(signer, uid), {
      db: env.DB,
      resolveKey: () => Promise.reject(new Error("D1")),
      now: () => NOW,
    });

    expect(res.status).toBe(500);
  });
});

describe("経路", () => {
  it("**HEAD では消さない** (404)", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await seed(uid, signer);
    const url = await purgeUrl(signer, uid);

    const res = await SELF.fetch(`https://example.com${url.pathname}${url.search}`, {
      method: "HEAD",
    });

    expect(res.status).toBe(404);
    expect(await rowCount(uid)).toBe(5);
  });

  it("形の違うクエリは 400", async () => {
    const res = await SELF.fetch(`https://example.com${PURGE_PATH}?v=1`);

    expect(res.status).toBe(400);
  });
});
