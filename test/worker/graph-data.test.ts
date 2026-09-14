import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { centerOf, type Minutes } from "../../src/shared/balance.ts";
import { DEFAULT_PARAMS } from "../../src/shared/graph.ts";
import { PH_ALL, publicIdOf } from "../../src/shared/ids.ts";
import { buildScale } from "../../src/shared/scale.ts";
import { renderStoredGraph } from "../../src/worker/graph-data.ts";
import { renderGraph } from "../../src/worker/svg.ts";
import { randomUid } from "./beacon-helpers.ts";

// 2026-09-14 15:30 UTC は日本時間で 2026-09-15 の 0:30。「今日」は Asia/Tokyo で決まる
const NOW = Date.parse("2026-09-14T15:30:00Z");
const TODAY = "2026-09-15";
const PH = "0123456789abcdef";

type Row = readonly [day: string, w: number, r: number];

async function store(uid: string, ph: string, rows: readonly Row[]): Promise<string> {
  const publicId = await publicIdOf(uid, ph);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO graphs (public_id, uid, ph) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    ).bind(publicId, uid, ph),
    ...rows.map(([day, w, r]) =>
      env.DB.prepare("INSERT INTO daily (uid, ph, day, w, r) VALUES (?, ?, ?, ?, ?)").bind(
        uid,
        ph,
        day,
        w,
        r,
      ),
    ),
  ]);
  return publicId;
}

/** 期待値。表示範囲の日と、母集団 (* の全期間) を別々に渡す。 */
function expected(display: readonly Row[], population: readonly Row[]): string {
  const minutes = ([, w, r]: Row): Minutes => ({ w, r });
  const all = population.map(minutes);
  return renderGraph({
    today: TODAY,
    days: new Map(display.map((row) => [row[0], minutes(row)])),
    scale: buildScale(all.map((d) => d.w + d.r)),
    center: centerOf(all),
    params: DEFAULT_PARAMS,
  });
}

const whole: readonly Row[] = [
  // 53 週より前。表示されないが四分位の母集団には入る
  ["2025-01-10", 50, 50],
  ["2026-09-01", 2, 8],
  ["2026-09-10", 10, 10],
  ["2026-09-14", 5, 30],
  // 日本時間の今日
  ["2026-09-15", 20, 20],
];

describe("共有 SVG を D1 から描く", () => {
  it("**全体用は * の行を描き、53 週より前の日は表示せず四分位の母集団に入れる**", async () => {
    const uid = randomUid();
    const publicId = await store(uid, PH_ALL, whole);

    const svg = await renderStoredGraph(env.DB, publicId, DEFAULT_PARAMS, NOW);

    expect(svg).toBe(expected(whole.slice(1), whole));
    // 母集団から古い日を外すと色が変わる (上の比較が母集団の違いを見分けられること)
    expect(svg).not.toBe(expected(whole.slice(1), whole.slice(1)));
  });

  it("**プロジェクト別の草も * の全期間のスケールで塗る** (ADR-0007 決定 4)", async () => {
    const uid = randomUid();
    await store(uid, PH_ALL, whole);
    const project: readonly Row[] = [["2026-09-14", 40, 0]];
    const publicId = await store(uid, PH, project);

    const svg = await renderStoredGraph(env.DB, publicId, DEFAULT_PARAMS, NOW);

    expect(svg).toBe(expected(project, whole));
    // プロジェクトだけで四分位を取ると別の色になる
    expect(svg).not.toBe(expected(project, project));
  });

  it("別の uid の * の行は混ざらない", async () => {
    const uid = randomUid();
    await store(randomUid(), PH_ALL, [["2026-09-14", 1000, 0]]);
    const publicId = await store(uid, PH_ALL, whole);

    expect(await renderStoredGraph(env.DB, publicId, DEFAULT_PARAMS, NOW)).toBe(
      expected(whole.slice(1), whole),
    );
  });

  it("**「今日」は日本時間で決める** (UTC の日付では右端の列が 1 日遅れる)", async () => {
    const uid = randomUid();
    const publicId = await store(uid, PH_ALL, whole);
    const svg = await renderStoredGraph(env.DB, publicId, DEFAULT_PARAMS, NOW);

    const utcToday = renderGraph({
      today: "2026-09-14",
      days: new Map(whole.slice(1).map(([day, w, r]) => [day, { w, r }])),
      scale: buildScale(whole.map(([, w, r]) => w + r)),
      center: centerOf(whole.map(([, w, r]) => ({ w, r }))),
      params: DEFAULT_PARAMS,
    });
    expect(svg).not.toBe(utcToday);
  });

  it("graphs に無い publicId は undefined", async () => {
    expect(await renderStoredGraph(env.DB, "0".repeat(32), DEFAULT_PARAMS, NOW)).toBeUndefined();
  });

  it("D1 の失敗は throw する (呼ぶ側が 503 にする)", async () => {
    const db = {
      prepare: () => {
        throw new Error("D1_ERROR");
      },
    } as unknown as D1Database;
    await expect(renderStoredGraph(db, "0".repeat(32), DEFAULT_PARAMS, NOW)).rejects.toThrow();
  });
});

describe("GET /v1/g/{publicId}.svg — D1 の記録", () => {
  it("200 と、Cosense で表示されるのに要るヘッダ。ETag で 304 を返す", async () => {
    const publicId = await store(randomUid(), PH_ALL, [["2026-09-14", 5, 5]]);
    const res = await SELF.fetch(`https://example.com/v1/g/${publicId}.svg`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=900");
    expect((await res.text()).startsWith("<svg")).toBe(true);

    const etag = res.headers.get("etag") ?? "";
    const again = await SELF.fetch(`https://example.com/v1/g/${publicId}.svg`, {
      headers: { "if-none-match": etag },
    });
    expect(again.status).toBe(304);
  });

  it("描画のクエリが効く (未知のキーは無視する)", async () => {
    const publicId = await store(randomUid(), PH_ALL, [["2026-09-14", 5, 5]]);
    const base = await (await SELF.fetch(`https://example.com/v1/g/${publicId}.svg`)).text();
    const cacheBusted = await (
      await SELF.fetch(`https://example.com/v1/g/${publicId}.svg?r=2`)
    ).text();
    const dark = await (
      await SELF.fetch(`https://example.com/v1/g/${publicId}.svg?theme=dark`)
    ).text();

    expect(cacheBusted).toBe(base);
    expect(dark).not.toBe(base);
  });

  it("**graphs に無い publicId と、形の違う publicId は 404**", async () => {
    for (const id of ["0".repeat(32), "ABCDEF".repeat(5) + "AB", "0".repeat(31), "../x"]) {
      const res = await SELF.fetch(`https://example.com/v1/g/${id}.svg`);
      expect(res.status, id).toBe(404);
    }
  });
});
