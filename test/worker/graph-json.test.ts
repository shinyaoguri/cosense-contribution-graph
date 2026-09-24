import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dataKeyOf, PH_ALL, publicIdOf } from "../../src/shared/ids.ts";
import { randomUid } from "./beacon-helpers.ts";

const PH = "0123456789abcdef";

type Row = readonly [day: string, w: number, r: number, pages: number, created: number];

/** graphs と daily に行を入れ、その (uid, ph) の JSON の URL を返す。 */
async function store(uid: string, ph: string, rows: readonly Row[]): Promise<string> {
  const publicId = await publicIdOf(uid, ph);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO graphs (public_id, uid, ph) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    ).bind(publicId, uid, ph),
    ...rows.map((row) =>
      env.DB.prepare(
        "INSERT INTO daily (uid, ph, day, w, r, pages, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(uid, ph, ...row),
    ),
  ]);
  return urlOf(publicId, await dataKeyOf(uid, ph));
}

function urlOf(publicId: string, dataKey: string): string {
  return `https://example.com/v1/g/${publicId}/${dataKey}.json`;
}

describe("GET /v1/g/{publicId}/{dataKey}.json", () => {
  it("**全期間の行を日付の昇順に、4 つの値つきで返す** (挿入の順によらない)", async () => {
    const uid = randomUid();
    const url = await store(uid, PH_ALL, [
      ["2026-09-14", 5, 30, 2, 1],
      ["2024-01-10", 50, 50, 7, 0],
      ["2026-09-01", 2, 8, 1, 0],
    ]);

    const res = await SELF.fetch(url);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      total: true,
      days: [
        { day: "2024-01-10", w: 50, r: 50, pages: 7, created: 0 },
        { day: "2026-09-01", w: 2, r: 8, pages: 1, created: 0 },
        { day: "2026-09-14", w: 5, r: 30, pages: 2, created: 1 },
      ],
    });
  });

  it("**プロジェクト別はその ph の行だけを返し、total は false**", async () => {
    const uid = randomUid();
    await store(uid, PH_ALL, [["2026-09-01", 9, 9, 9, 9]]);
    const url = await store(uid, PH, [["2026-09-01", 1, 2, 3, 0]]);
    // 別の uid の同じ ph は混ざらない
    await store(randomUid(), PH, [["2026-09-02", 4, 4, 4, 4]]);

    const res = await SELF.fetch(url);

    expect(await res.json()).toEqual({
      total: false,
      days: [{ day: "2026-09-01", w: 1, r: 2, pages: 3, created: 0 }],
    });
  });

  it("**uid も ph も本文に出さない**", async () => {
    const uid = randomUid();
    const url = await store(uid, PH, [["2026-09-01", 1, 2, 3, 0]]);

    const body = await (await SELF.fetch(url)).text();

    expect(body).not.toContain(uid);
    expect(body).not.toContain(PH);
  });

  it("記録が 1 行も無ければ days は空", async () => {
    const url = await store(randomUid(), PH_ALL, []);

    expect(await (await SELF.fetch(url)).json()).toEqual({ total: true, days: [] });
  });

  describe("**鍵が合わなければ 404** (草の URL から内訳を読ませない。ADR-0020)", () => {
    it("草の publicId を鍵の位置に置いても読めない", async () => {
      const uid = randomUid();
      await store(uid, PH_ALL, [["2026-09-01", 1, 1, 1, 1]]);
      const publicId = await publicIdOf(uid, PH_ALL);

      const res = await SELF.fetch(urlOf(publicId, publicId));

      expect(res.status).toBe(404);
    });

    it("合算の鍵ではプロジェクト別を開けず、その逆もできない", async () => {
      const uid = randomUid();
      await store(uid, PH_ALL, [["2026-09-01", 1, 1, 1, 1]]);
      await store(uid, PH, [["2026-09-01", 1, 1, 1, 1]]);

      const project = await SELF.fetch(
        urlOf(await publicIdOf(uid, PH), await dataKeyOf(uid, PH_ALL)),
      );
      const total = await SELF.fetch(
        urlOf(await publicIdOf(uid, PH_ALL), await dataKeyOf(uid, PH)),
      );

      expect(project.status).toBe(404);
      expect(total.status).toBe(404);
    });

    it("別の uid の鍵では開けない", async () => {
      const uid = randomUid();
      await store(uid, PH_ALL, [["2026-09-01", 1, 1, 1, 1]]);

      const res = await SELF.fetch(
        urlOf(await publicIdOf(uid, PH_ALL), await dataKeyOf(randomUid(), PH_ALL)),
      );

      expect(res.status).toBe(404);
    });

    it("1 文字違いの鍵では開けない", async () => {
      const uid = randomUid();
      await store(uid, PH_ALL, [["2026-09-01", 1, 1, 1, 1]]);
      const key = await dataKeyOf(uid, PH_ALL);
      const wrong = `${key.slice(0, -1)}${key.endsWith("0") ? "1" : "0"}`;

      const res = await SELF.fetch(urlOf(await publicIdOf(uid, PH_ALL), wrong));

      expect(res.status).toBe(404);
    });

    it("graphs に無い publicId も同じ 404", async () => {
      const uid = randomUid();

      const res = await SELF.fetch(
        urlOf(await publicIdOf(uid, PH_ALL), await dataKeyOf(uid, PH_ALL)),
      );

      expect(res.status).toBe(404);
    });
  });

  it.each([
    ["publicId が短い", `${"0".repeat(31)}/${"0".repeat(32)}`],
    ["鍵が長い", `${"0".repeat(32)}/${"0".repeat(33)}`],
    ["大文字", `${"A".repeat(32)}/${"0".repeat(32)}`],
    ["demo", `demo/${"0".repeat(32)}`],
    ["階層が深い", `${"0".repeat(32)}/${"0".repeat(32)}/x`],
  ])("形の違う URL は 404 (%s)", async (_name, path) => {
    const res = await SELF.fetch(`https://example.com/v1/g/${path}.json`);
    expect(res.status).toBe(404);
  });

  it("**ほかのサイトから読めて、検索には載らず、何も実行させないヘッダを付ける**", async () => {
    const url = await store(randomUid(), PH_ALL, [["2026-09-01", 1, 1, 1, 1]]);

    const res = await SELF.fetch(url);

    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("public, max-age=900");
  });

  it("**ETag が一致すれば 304** (草と同じく本文の SHA-256)", async () => {
    const url = await store(randomUid(), PH_ALL, [["2026-09-01", 1, 1, 1, 1]]);
    const etag = (await SELF.fetch(url)).headers.get("etag");

    const res = await SELF.fetch(url, { headers: { "if-none-match": `W/${etag}` } });

    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(res.status).toBe(304);
  });

  it("HEAD も受ける", async () => {
    const url = await store(randomUid(), PH_ALL, [["2026-09-01", 1, 1, 1, 1]]);

    const res = await SELF.fetch(url, { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });
});
