import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildRevokeUrl, REVOKE_PARAM, REVOKE_PATH } from "../../src/shared/revoke.ts";
import { handleRevoke } from "../../src/worker/enroll.ts";
import { createSigner, gifWidth, NOW, randomUid, type Signer } from "./beacon-helpers.ts";

const ORIGIN = "https://example.com";

const NOW_SECONDS = NOW / 1000;

function revokeUrl(
  signer: Signer,
  uid: string,
  target = signer.kid,
  time = NOW_SECONDS,
): Promise<URL> {
  return buildRevokeUrl(ORIGIN, { uid, kid: signer.kid, target, time }, signer.sign).then(
    (href) => new URL(href),
  );
}

function revoke(url: URL, signer: Signer, nowMs = NOW, db: D1Database = env.DB): Promise<Response> {
  return handleRevoke(url, { db, resolveKey: signer.resolveKey, now: () => nowMs });
}

/** `keys` に鍵を 1 つ入れる (登録の代わり。登録そのものは enroll.test.ts が見る)。 */
async function addKey(uid: string, kid: string, publicKey: Uint8Array<ArrayBuffer>): Promise<void> {
  await env.DB.prepare("INSERT INTO keys (uid, kid, pubkey, created) VALUES (?, ?, ?, ?)")
    .bind(uid, kid, publicKey, NOW_SECONDS)
    .run();
}

async function keyCount(uid: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM keys WHERE uid = ?")
    .bind(uid)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 触ったら throw する D1 (enroll.test.ts と同じ)。 */
function untouchableDb(): D1Database {
  return new Proxy(env.DB, {
    get() {
      throw new Error("D1 に触った");
    },
  });
}

describe("失効", () => {
  it("**この端末の鍵を消し、幅 17 を返す**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await addKey(uid, signer.kid, signer.publicKey);

    const res = await revoke(await revokeUrl(signer, uid), signer);

    expect(res.status).toBe(200);
    expect(await gifWidth(res)).toBe(17);
    expect(await keyCount(uid)).toBe(0);
  });

  it("**ほかの端末の鍵も消せる。同じ uid の行だけ**", async () => {
    const uid = randomUid();
    const other = randomUid();
    const signer = await createSigner();
    const target = await createSigner();
    await addKey(uid, signer.kid, signer.publicKey);
    await addKey(uid, target.kid, target.publicKey);
    await addKey(other, target.kid, target.publicKey);

    const res = await revoke(await revokeUrl(signer, uid, target.kid), signer);

    expect(await gifWidth(res)).toBe(17);
    expect(await keyCount(uid)).toBe(1);
    // 別の uid の同じ kid は残る
    expect(await keyCount(other)).toBe(1);
  });

  it("**もう無い鍵を消しても 200 と幅 16** (押し直しても成功にする)", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    const gone = await createSigner();
    await addKey(uid, signer.kid, signer.publicKey);

    const res = await revoke(await revokeUrl(signer, uid, gone.kid), signer);

    expect(res.status).toBe(200);
    expect(await gifWidth(res)).toBe(16);
  });
});

describe("断る", () => {
  it("**形が違えば 400。D1 に触らない**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    const url = await revokeUrl(signer, uid);
    url.searchParams.set(REVOKE_PARAM.target, "xyz");

    const res = await revoke(url, signer, NOW, untouchableDb());

    expect(res.status).toBe(400);
  });

  it("**60 秒の窓の外なら 403。D1 に触らない** (記録の 300 秒より狭い)", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    const url = await revokeUrl(signer, uid, signer.kid, NOW_SECONDS - 61);

    const res = await revoke(url, signer, NOW, untouchableDb());

    expect(res.status).toBe(403);
  });

  it("窓の内側 (59 秒前) なら通る", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await addKey(uid, signer.kid, signer.publicKey);

    const res = await revoke(await revokeUrl(signer, uid, signer.kid, NOW_SECONDS - 59), signer);

    expect(res.status).toBe(200);
  });

  it("**署名した鍵が登録されていなければ 403。鍵は消えない**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    const target = await createSigner();
    await addKey(uid, target.kid, target.publicKey);

    const res = await handleRevoke(await revokeUrl(signer, uid, target.kid), {
      db: env.DB,
      resolveKey: async () => undefined,
      now: () => NOW,
    });

    expect(res.status).toBe(403);
    expect(await keyCount(uid)).toBe(1);
  });

  it("**署名が合わなければ 403。鍵は消えない**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    const impostor = await createSigner();
    await addKey(uid, signer.kid, signer.publicKey);
    const url = await revokeUrl(signer, uid);

    // 署名を別の鍵のものに差し替える
    const forged = await revokeUrl(impostor, uid);
    url.searchParams.set(
      REVOKE_PARAM.signature,
      forged.searchParams.get(REVOKE_PARAM.signature) ?? "",
    );
    const res = await revoke(url, signer);

    expect(res.status).toBe(403);
    expect(await keyCount(uid)).toBe(1);
  });

  it("D1 が失敗したら 500", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    const res = await handleRevoke(await revokeUrl(signer, uid), {
      db: env.DB,
      resolveKey: () => Promise.reject(new Error("D1")),
      now: () => NOW,
    });

    expect(res.status).toBe(500);
  });
});

describe("経路", () => {
  it("**HEAD では鍵を消さない** (404)", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await addKey(uid, signer.kid, signer.publicKey);
    const url = await revokeUrl(signer, uid);

    const res = await SELF.fetch(`https://example.com${url.pathname}${url.search}`, {
      method: "HEAD",
    });

    expect(res.status).toBe(404);
    expect(await keyCount(uid)).toBe(1);
  });

  it("形の違うクエリは 400", async () => {
    const res = await SELF.fetch(`https://example.com${REVOKE_PATH}?v=1`);

    expect(res.status).toBe(400);
  });
});
