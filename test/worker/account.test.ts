import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ACCOUNT_PATH } from "../../src/shared/auth.ts";
import { PH_ALL, publicIdOf } from "../../src/shared/ids.ts";
import { DELETE_CONFIRM_WORD, handleAccount } from "../../src/worker/account.ts";
import { FAVICON_LINK } from "../../src/worker/favicon.ts";
import { csrfToken, sealSession } from "../../src/worker/session.ts";
import { createSigner, NOW, randomUid } from "./beacon-helpers.ts";

const SECRET = "test-secret";
const ORIGIN = "https://example.com";
const NOW_SECONDS = NOW / 1000;

const deps = (now = NOW) => ({
  db: env.DB,
  secret: SECRET,
  publicOrigin: ORIGIN,
  now: () => now,
});

async function cookieFor(uid: string, nowMs = NOW): Promise<string> {
  return (await sealSession(SECRET, uid, nowMs)).split(";")[0] ?? "";
}

function get(cookie?: string, now = NOW): Promise<Response> {
  return handleAccount(
    new Request(`${ORIGIN}${ACCOUNT_PATH}`, {
      headers: cookie === undefined ? {} : { cookie },
    }),
    deps(now),
  );
}

function post(body: Record<string, string>, cookie?: string): Promise<Response> {
  return handleAccount(
    new Request(`${ORIGIN}${ACCOUNT_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: new URLSearchParams(body).toString(),
    }),
    deps(),
  );
}

async function addKey(
  uid: string,
  kid: string,
  publicKey: Uint8Array<ArrayBuffer>,
  created = NOW_SECONDS,
) {
  await env.DB.prepare("INSERT INTO keys (uid, kid, pubkey, created) VALUES (?, ?, ?, ?)")
    .bind(uid, kid, publicKey, created)
    .run();
}

async function keyCount(uid: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM keys WHERE uid = ?")
    .bind(uid)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("一覧", () => {
  it("**サインインしていなければ何も出さず、サインインを促す**", async () => {
    const res = await get();
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("/auth/start");
    expect(html).not.toContain("登録した端末");
  });

  it("**期限切れの cookie も同じ** (30 分を過ぎたら見せない)", async () => {
    const uid = randomUid();
    const cookie = await cookieFor(uid);

    const res = await get(cookie, NOW + 1801_000);

    expect(await res.text()).toContain("/auth/start");
  });

  it("**登録した端末の kid と登録日時を出す。uid は出さない**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await addKey(uid, signer.kid, signer.publicKey);

    const res = await get(await cookieFor(uid));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(signer.kid);
    expect(html).toContain("2026-09-14");
    expect(html).not.toContain(uid);
  });

  it("**ほかの人の端末は出さない**", async () => {
    const uid = randomUid();
    const other = randomUid();
    const mine = await createSigner();
    const theirs = await createSigner();
    await addKey(uid, mine.kid, mine.publicKey);
    await addKey(other, theirs.kid, theirs.publicKey);

    const html = await (await get(await cookieFor(uid))).text();

    expect(html).toContain(mine.kid);
    expect(html).not.toContain(theirs.kid);
  });

  it("1 台も無ければその旨を出す", async () => {
    const html = await (await get(await cookieFor(randomUid()))).text();

    expect(html).toContain("登録された端末はありません");
  });

  it("**スクリプトを載せず、CSP で script-src を止める**", async () => {
    const res = await get(await cookieFor(randomUid()));

    expect(await res.text()).not.toContain("<script");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("失効", () => {
  it("**フォームから失効させ、303 で一覧に戻す**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await addKey(uid, signer.kid, signer.publicKey);
    const cookie = await cookieFor(uid);
    const csrf = await csrfToken(SECRET, { uid, issuedAt: NOW_SECONDS });

    const res = await post({ kid: signer.kid, csrf }, cookie);

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(ACCOUNT_PATH);
    expect(await keyCount(uid)).toBe(0);
  });

  it("**ほかの人の端末は消せない** (自分の uid の行だけ消す)", async () => {
    const uid = randomUid();
    const other = randomUid();
    const mine = await createSigner();
    const theirs = await createSigner();
    await addKey(uid, mine.kid, mine.publicKey);
    await addKey(other, theirs.kid, theirs.publicKey);
    const csrf = await csrfToken(SECRET, { uid, issuedAt: NOW_SECONDS });

    const res = await post({ kid: theirs.kid, csrf }, await cookieFor(uid));

    expect(res.status).toBe(303);
    expect(await keyCount(other)).toBe(1);
  });

  it("**CSRF トークンが違えば 403。消えない**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await addKey(uid, signer.kid, signer.publicKey);

    const res = await post({ kid: signer.kid, csrf: "wrong" }, await cookieFor(uid));

    expect(res.status).toBe(403);
    expect(await keyCount(uid)).toBe(1);
  });

  it("**ほかの人のセッションの CSRF トークンも通らない**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await addKey(uid, signer.kid, signer.publicKey);
    const foreign = await csrfToken(SECRET, { uid: randomUid(), issuedAt: NOW_SECONDS });

    const res = await post({ kid: signer.kid, csrf: foreign }, await cookieFor(uid));

    expect(res.status).toBe(403);
    expect(await keyCount(uid)).toBe(1);
  });

  it("kid の形が違えば 400", async () => {
    const uid = randomUid();
    const csrf = await csrfToken(SECRET, { uid, issuedAt: NOW_SECONDS });

    const res = await post({ kid: "xyz", csrf }, await cookieFor(uid));

    expect(res.status).toBe(400);
  });

  it("**サインインしていなければ消さない**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await addKey(uid, signer.kid, signer.publicKey);
    const csrf = await csrfToken(SECRET, { uid, issuedAt: NOW_SECONDS });

    const res = await post({ kid: signer.kid, csrf });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/auth/start");
    expect(await keyCount(uid)).toBe(1);
  });
});

describe("あなたの草", () => {
  async function withGraph(): Promise<{ uid: string; publicId: string }> {
    const uid = randomUid();
    const publicId = await publicIdOf(uid, PH_ALL);
    await env.DB.prepare("INSERT INTO graphs (public_id, uid, ph) VALUES (?, ?, ?)")
      .bind(publicId, uid, PH_ALL)
      .run();
    return { uid, publicId };
  }

  it("**合算の草の URL を出す。プロジェクト別は出せないと案内する**", async () => {
    const { uid, publicId } = await withGraph();

    const html = await (await get(await cookieFor(uid))).text();

    expect(html).toContain(`${ORIGIN}/v1/g/${publicId}.svg`);
    expect(html).toContain("ページメニュー「cosense-grass」にプロジェクト名つきで並びます");
  });

  it("**草そのものを画像で出す** (URL を別のタブで開かなくてよい)", async () => {
    const { uid, publicId } = await withGraph();

    const html = await (await get(await cookieFor(uid))).text();

    expect(html).toContain(`<img src="/v1/g/${publicId}.svg"`);
  });

  it("**草を出すので CSP は同じオリジンの画像を許す**", async () => {
    const { uid } = await withGraph();

    const res = await get(await cookieFor(uid));

    expect(res.headers.get("content-security-policy")).toContain("img-src 'self'");
  });

  it("**favicon を指す** (Cosense のボタンと同じ絵。Issue #130)", async () => {
    const { uid } = await withGraph();

    const html = await (await get(await cookieFor(uid))).text();

    expect(html).toContain(FAVICON_LINK);
  });

  it("まだ草が無ければその旨を出し、画像も出さない", async () => {
    const html = await (await get(await cookieFor(randomUid()))).text();

    expect(html).toContain("まだ草がありません");
    expect(html).not.toContain("<img");
  });
});

describe("全データの削除", () => {
  /** 5 つの表すべてに行を入れる */
  async function seed(uid: string, kid: string, publicKey: Uint8Array<ArrayBuffer>) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO keys (uid, kid, pubkey, created) VALUES (?, ?, ?, ?)").bind(
        uid,
        kid,
        publicKey,
        NOW_SECONDS,
      ),
      env.DB.prepare("INSERT INTO graphs (public_id, uid, ph) VALUES (?, ?, ?)").bind(
        await publicIdOf(uid, PH_ALL),
        uid,
        PH_ALL,
      ),
      env.DB.prepare(
        "INSERT INTO daily (uid, ph, day, w, r, pages, created) VALUES (?, ?, ?, 1, 1, 1, 1)",
      ).bind(uid, PH_ALL, "2026-09-14"),
      env.DB.prepare(
        "INSERT INTO daybits (uid, ph, day, wbits, rbits) VALUES (?, ?, ?, ?, ?)",
      ).bind(uid, PH_ALL, "2026-09-14", new Uint8Array(180), new Uint8Array(180)),
      env.DB.prepare("INSERT INTO enroll_tokens (token_hash, uid, expires) VALUES (?, ?, ?)").bind(
        `hash-${uid}`,
        uid,
        NOW_SECONDS + 300,
      ),
    ]);
  }

  async function rowCount(uid: string): Promise<number> {
    let total = 0;
    for (const table of ["keys", "graphs", "daily", "daybits", "enroll_tokens"]) {
      const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE uid = ?`)
        .bind(uid)
        .first<{ n: number }>();
      total += row?.n ?? 0;
    }
    return total;
  }

  it("**合言葉を入れると 5 つの表から消える**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await seed(uid, signer.kid, signer.publicKey);
    const csrf = await csrfToken(SECRET, { uid, issuedAt: NOW_SECONDS });

    const res = await post(
      { action: "delete", word: DELETE_CONFIRM_WORD, csrf },
      await cookieFor(uid),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("削除しました");
    expect(await rowCount(uid)).toBe(0);
  });

  it("**合言葉が違えば消えない**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await seed(uid, signer.kid, signer.publicKey);
    const csrf = await csrfToken(SECRET, { uid, issuedAt: NOW_SECONDS });

    const res = await post({ action: "delete", word: "けす", csrf }, await cookieFor(uid));

    expect(res.status).toBe(400);
    expect(await rowCount(uid)).toBe(5);
  });

  it("**CSRF トークンが無ければ消えない**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await seed(uid, signer.kid, signer.publicKey);

    const res = await post(
      { action: "delete", word: DELETE_CONFIRM_WORD, csrf: "wrong" },
      await cookieFor(uid),
    );

    expect(res.status).toBe(403);
    expect(await rowCount(uid)).toBe(5);
  });

  it("**ほかの人のデータは消えない**", async () => {
    const uid = randomUid();
    const other = randomUid();
    const mine = await createSigner();
    const theirs = await createSigner();
    await seed(uid, mine.kid, mine.publicKey);
    await seed(other, theirs.kid, theirs.publicKey);
    const csrf = await csrfToken(SECRET, { uid, issuedAt: NOW_SECONDS });

    await post({ action: "delete", word: DELETE_CONFIRM_WORD, csrf }, await cookieFor(uid));

    expect(await rowCount(other)).toBe(5);
  });

  it("**サインインしていなければ消えない**", async () => {
    const uid = randomUid();
    const signer = await createSigner();
    await seed(uid, signer.kid, signer.publicKey);
    const csrf = await csrfToken(SECRET, { uid, issuedAt: NOW_SECONDS });

    const res = await post({ action: "delete", word: DELETE_CONFIRM_WORD, csrf });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/auth/start");
    expect(await rowCount(uid)).toBe(5);
  });
});

describe("設定が足りない", () => {
  it("secret が空なら 500", async () => {
    const res = await handleAccount(new Request(`${ORIGIN}${ACCOUNT_PATH}`), {
      db: env.DB,
      secret: "",
      publicOrigin: ORIGIN,
      now: () => NOW,
    });

    expect(res.status).toBe(500);
  });
});
