import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dataKeyOf, PH_ALL, publicIdOf } from "../../src/shared/ids.ts";
import { randomUid } from "./beacon-helpers.ts";

const PH = "0123456789abcdef";

type Row = readonly [
  day: string,
  w: number,
  r: number,
  pages: number,
  created: number,
  wc?: number,
  wo?: number,
  links?: number,
];

/** graphs と daily に行を入れ、その (uid, ph) の JSON の URL を返す。 */
async function store(uid: string, ph: string, rows: readonly Row[]): Promise<string> {
  const publicId = await publicIdOf(uid, ph);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO graphs (public_id, uid, ph) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    ).bind(publicId, uid, ph),
    ...rows.map(([day, w, r, pages, created, wc = 0, wo = 0, links = 0]) =>
      env.DB.prepare(
        "INSERT INTO daily (uid, ph, day, w, r, pages, created, wc, wo, links) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(uid, ph, day, w, r, pages, created, wc, wo, links),
    ),
  ]);
  return urlOf(publicId, await dataKeyOf(uid, ph));
}

function urlOf(publicId: string, dataKey: string): string {
  return `https://example.com/v1/g/${publicId}/${dataKey}.json`;
}

describe("GET /v1/g/{publicId}/{dataKey}.json", () => {
  it("**全期間の行を日付の昇順に、7 つの値つきで返す** (挿入の順によらない)", async () => {
    const uid = randomUid();
    const url = await store(uid, PH_ALL, [
      ["2026-09-14", 5, 30, 2, 1, 2, 1, 3],
      ["2024-01-10", 50, 50, 7, 0],
      ["2026-09-01", 2, 8, 1, 0],
    ]);

    const res = await SELF.fetch(url);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      total: true,
      days: [
        { day: "2024-01-10", w: 50, r: 50, pages: 7, created: 0, wc: 0, wo: 0, links: 0 },
        { day: "2026-09-01", w: 2, r: 8, pages: 1, created: 0, wc: 0, wo: 0, links: 0 },
        { day: "2026-09-14", w: 5, r: 30, pages: 2, created: 1, wc: 2, wo: 1, links: 3 },
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
      days: [{ day: "2026-09-01", w: 1, r: 2, pages: 3, created: 0, wc: 0, wo: 0, links: 0 }],
    });
  });

  it("**uid も ph も本文に出さない**", async () => {
    const uid = randomUid();
    const url = await store(uid, PH, [["2026-09-01", 1, 2, 3, 0]]);

    const body = await (await SELF.fetch(url)).text();

    expect(body).not.toContain(uid);
    expect(body).not.toContain(PH);
  });

  describe("**時間帯は 1 日 3 分割 (朝 9–13 / 昼 13–18 / 夜 18–翌 9) の slots で返す** (ADR-0024 決定 1)", () => {
    type Quad = readonly [number, number, number, number];

    /** 区間 (sw0..sw3 / sr0..sr3) つきの行を入れる。w / r は区間の和にする */
    async function storeSegments(
      uid: string,
      rows: readonly (readonly [day: string, sw: Quad, sr: Quad])[],
    ): Promise<string> {
      const url = await store(uid, PH_ALL, []);
      const sum = (q: Quad) => q.reduce((a, b) => a + b, 0);
      await env.DB.batch(
        rows.map(([day, sw, sr]) =>
          env.DB.prepare(
            "INSERT INTO daily (uid, ph, day, w, r, sw0, sw1, sw2, sw3, sr0, sr1, sr2, sr3) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).bind(uid, PH_ALL, day, sum(sw), sum(sr), ...sw, ...sr),
        ),
      );
      return url;
    }

    async function slotsOfBody(url: string): Promise<Record<string, unknown>> {
      const { days } = (await (await SELF.fetch(url)).json()) as {
        days: { day: string; slots?: unknown }[];
      };
      return Object.fromEntries(days.map(({ day, slots }) => [day, slots]));
    }

    it("**夜は その日の 18–24 時 + 翌日の 0–9 時**。朝と昼はその日の区間 1・2", async () => {
      const url = await storeSegments(randomUid(), [
        ["2026-09-01", [1, 2, 3, 4], [10, 20, 30, 40]],
        ["2026-09-02", [5, 6, 7, 8], [50, 60, 70, 80]],
      ]);

      expect(await slotsOfBody(url)).toEqual({
        "2026-09-01": [
          { w: 2, r: 20 },
          { w: 3, r: 30 },
          { w: 4 + 5, r: 40 + 50 },
        ],
        // 翌日の行が無ければ、夜はその日の 18–24 時だけ
        "2026-09-02": [
          { w: 6, r: 60 },
          { w: 7, r: 70 },
          { w: 8, r: 80 },
        ],
      });
    });

    it("翌日が内訳なし (区間が NULL) なら、夜はその日の 18–24 時だけ", async () => {
      const uid = randomUid();
      const url = await storeSegments(uid, [["2026-09-01", [1, 2, 3, 4], [0, 0, 0, 0]]]);
      await store(uid, PH_ALL, [["2026-09-02", 9, 9, 1, 0]]);

      expect((await slotsOfBody(url))["2026-09-01"]).toEqual([
        { w: 2, r: 0 },
        { w: 3, r: 0 },
        { w: 4, r: 0 },
      ]);
    });

    it("**内訳なしの日は slots のキー自体を出さない** (0 で埋めると活動なしと区別できない)", async () => {
      const url = await store(randomUid(), PH_ALL, [["2026-09-01", 5, 5, 1, 0]]);

      const { days } = (await (await SELF.fetch(url)).json()) as { days: object[] };

      expect(days[0]).not.toHaveProperty("slots");
    });
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
