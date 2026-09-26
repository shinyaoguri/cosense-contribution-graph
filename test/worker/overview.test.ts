import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PH_ALL, publicIdOf } from "../../src/shared/ids.ts";
import { DEFAULT_PARAMS } from "../../src/worker/graph/grid.ts";
import { sumOverview } from "../../src/worker/graph/overview.ts";
import { renderStoredOverview } from "../../src/worker/graph-data.ts";
import { renderOverview } from "../../src/worker/overview-svg.ts";
import { randomUid } from "./beacon-helpers.ts";

// 2026-09-14 15:30 UTC は日本時間で 2026-09-15 の 0:30。「今日」は Asia/Tokyo で決まる
const NOW = Date.parse("2026-09-14T15:30:00Z");
const PH = "0123456789abcdef";
const DEMO_URL = "https://example.com/v1/g/demo/overview.svg";

type Row = readonly [day: string, w: number, r: number, wc: number, wo: number];

async function store(uid: string, ph: string, rows: readonly Row[]): Promise<string> {
  const publicId = await publicIdOf(uid, ph);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO graphs (public_id, uid, ph) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    ).bind(publicId, uid, ph),
    ...rows.map(([day, w, r, wc, wo]) =>
      env.DB.prepare(
        "INSERT INTO daily (uid, ph, day, w, r, wc, wo) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(uid, ph, day, w, r, wc, wo),
    ),
  ]);
  return publicId;
}

function expected(rows: readonly Row[]): string {
  return renderOverview({
    totals: sumOverview(rows.map(([, w, r, wc, wo]) => ({ w, r, wc, wo }))),
    theme: DEFAULT_PARAMS.theme,
    palette: DEFAULT_PARAMS.palette,
  });
}

/** `<text>` の中身を、タグを外して並べる (軸名と %)。 */
function labelsOf(svg: string): string[] {
  return [...svg.matchAll(/<text\b[^>]*>(.*?)<\/text>/g)].map((m) =>
    (m[1] ?? "").replace(/<[^>]+>/g, " ").trim(),
  );
}

describe("GET /v1/g/demo/overview.svg", () => {
  it("200 と、Cosense で表示されるのに要るヘッダ。width / height / viewBox を出す", async () => {
    const res = await SELF.fetch(DEMO_URL);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=900");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(await res.text()).toMatch(/^<svg [^>]*width="300" height="220" viewBox="0 0 300 220"/);
  });

  it("ETag で 304 を返す", async () => {
    const etag = (await SELF.fetch(DEMO_URL)).headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    const again = await SELF.fetch(DEMO_URL, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
  });

  it("**デモは 4 軸すべてに値がある。** theme と palette が効き、過去の年は空", async () => {
    const svg = await (await SELF.fetch(DEMO_URL)).text();
    expect(labelsOf(svg).every((label) => label.endsWith("%"))).toBe(true);

    const dark = await (await SELF.fetch(`${DEMO_URL}?theme=dark`)).text();
    const yellow = await (await SELF.fetch(`${DEMO_URL}?palette=blue-yellow`)).text();
    expect(dark).not.toBe(svg);
    expect(yellow).not.toBe(svg);

    const past = await (await SELF.fetch(`${DEMO_URL}?year=2020`)).text();
    expect(labelsOf(past)).toEqual(["関わる", "読む", "作る", "育てる"]);
  });

  it("**草の SVG の経路とは別** (草のデモは変わらない)", async () => {
    const grass = await (await SELF.fetch("https://example.com/v1/g/demo.svg")).text();
    const overview = await (await SELF.fetch(DEMO_URL)).text();
    expect(grass).not.toBe(overview);
    expect(grass).toContain('data-part="grid"');
  });
});

describe("renderStoredOverview", () => {
  it("**草と同じ期間の行を合計する** (右端は今日、左端は 7 × 52 日前。それより古い行は入らない)", async () => {
    const rows: Row[] = [
      ["2026-09-15", 10, 5, 2, 3],
      ["2025-09-16", 4, 0, 0, 4],
    ];
    const publicId = await store(randomUid(), PH_ALL, [...rows, ["2025-09-15", 99, 99, 0, 0]]);

    expect(await renderStoredOverview(env.DB, publicId, DEFAULT_PARAMS, NOW)).toBe(expected(rows));
  });

  it("週数を減らすとその期間だけ、年を指定するとその年の 12/31 までを合計する", async () => {
    const publicId = await store(randomUid(), PH_ALL, [
      ["2026-09-15", 10, 0, 10, 0],
      ["2026-09-01", 0, 7, 0, 0],
      ["2025-12-31", 3, 0, 0, 3],
    ]);

    const weeks = await renderStoredOverview(
      env.DB,
      publicId,
      { ...DEFAULT_PARAMS, weeks: 1 },
      NOW,
    );
    expect(labelsOf(weeks ?? "")).toEqual(["関わる", "読む", "作る 100%", "育てる"]);

    const year = await renderStoredOverview(env.DB, publicId, DEFAULT_PARAMS, NOW, "2025-12-31");
    expect(labelsOf(year ?? "")).toEqual(["関わる 100%", "読む", "作る", "育てる"]);
  });

  it("**プロジェクト別はその ph の行だけを合計する**", async () => {
    const uid = randomUid();
    await store(uid, PH_ALL, [["2026-09-15", 50, 50, 0, 0]]);
    const publicId = await store(uid, PH, [["2026-09-15", 4, 0, 1, 1]]);

    const svg = await renderStoredOverview(env.DB, publicId, DEFAULT_PARAMS, NOW);
    expect(labelsOf(svg ?? "")).toEqual(["関わる 25%", "読む", "作る 25%", "育てる 50%"]);
  });

  it("graphs に無い publicId は undefined", async () => {
    expect(await renderStoredOverview(env.DB, "0".repeat(32), DEFAULT_PARAMS, NOW)).toBeUndefined();
  });
});

describe("GET /v1/g/{publicId}/overview.svg", () => {
  it("D1 の記録から描き、theme が効く", async () => {
    const publicId = await store(randomUid(), PH_ALL, [["2026-09-15", 10, 5, 2, 3]]);
    const url = `https://example.com/v1/g/${publicId}/overview.svg`;

    const res = await SELF.fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    const light = await res.text();
    const dark = await (await SELF.fetch(`${url}?theme=dark`)).text();
    expect(light.startsWith("<svg")).toBe(true);
    expect(dark).not.toBe(light);
  });

  it("**graphs に無い publicId と、形の違う publicId は 404**", async () => {
    for (const id of ["0".repeat(32), `${"ABCDEF".repeat(5)}AB`, "0".repeat(31)]) {
      const res = await SELF.fetch(`https://example.com/v1/g/${id}/overview.svg`);
      expect(res.status, id).toBe(404);
    }
  });
});
