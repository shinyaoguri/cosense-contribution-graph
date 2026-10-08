import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GRAPH_FORM } from "../../src/shared/grass.ts";
import { PH_ALL, publicIdOf } from "../../src/shared/ids.ts";
import { centerOf, type Minutes } from "../../src/worker/graph/balance.ts";
import type { GrassDay } from "../../src/worker/graph/grass.ts";
import { buildScale } from "../../src/worker/graph/scale.ts";
import { DEFAULT_SCHEME } from "../../src/worker/graph/scheme.ts";
import { type GrassOptions, renderStoredGrass } from "../../src/worker/graph-data.ts";
import { renderGrass } from "../../src/worker/grass-svg.ts";
import { randomUid } from "./beacon-helpers.ts";

/**
 * 図を D1 の記録から描く (`renderStoredGrass`)。`{publicId}.svg` の既定の形 (1 年 × 1 日) で、
 * 母集団・今日・計測開始日・年の扱いを見る。時間帯の区間と 3 分割の形は `card.test.ts` が見る
 */

// 2026-09-14 15:30 UTC は日本時間で 2026-09-15 の 0:30。「今日」は Asia/Tokyo で決まる
const NOW = Date.parse("2026-09-14T15:30:00Z");
const TODAY = "2026-09-15";
const PH = "0123456789abcdef";
const OPTIONS: GrassOptions = {
  form: GRAPH_FORM,
  theme: "light",
  mode: "bi",
  palette: DEFAULT_SCHEME,
  lang: "ja",
};
const noIcon = async () => undefined;

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

const render = (publicId: string, extra: Partial<GrassOptions> = {}, db: D1Database = env.DB) =>
  renderStoredGrass(db, publicId, { ...OPTIONS, ...extra }, NOW, noIcon);

/** 期待値。表示する日と、母集団 (* の全期間) を別々に渡す。`total` は合算の図か (印が付く) */
function expected(
  display: readonly Row[],
  population: readonly Row[],
  extra: { total?: boolean; today?: string; end?: string } = {},
): string {
  const day = ([, w, r]: Row): GrassDay => ({ w, r, wc: 0, wo: 0 });
  const all: Minutes[] = population.map(([, w, r]) => ({ w, r }));
  const startDay = population.map(([d]) => d).sort()[0];
  return renderGrass({
    today: extra.today ?? TODAY,
    ...(extra.end === undefined ? {} : { end: extra.end }),
    ...(startDay === undefined ? {} : { startDay }),
    form: GRAPH_FORM,
    mode: "bi",
    days: new Map(display.map((row) => [row[0], day(row)])),
    slotScale: buildScale([]),
    slotCenter: centerOf([]),
    dayScale: buildScale(all.map((d) => d.w + d.r)),
    dayCenter: centerOf(all),
    theme: "light",
    palette: DEFAULT_SCHEME,
    lang: "ja",
    total: extra.total ?? false,
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

describe("図を D1 から描く", () => {
  it("**全体用は * の行を描き、表示範囲より前の日は表示せず四分位の母集団に入れる**", async () => {
    const publicId = await store(randomUid(), PH_ALL, whole);

    const svg = await render(publicId);

    expect(svg).toBe(expected(whole.slice(1), whole, { total: true }));
    // 母集団から古い日を外すと色が変わる (上の比較が母集団の違いを見分けられること)
    expect(svg).not.toBe(expected(whole.slice(1), whole.slice(1), { total: true }));
  });

  it("**プロジェクト別の図も * の全期間のスケールで塗る** (ADR-0007 決定 4)", async () => {
    const uid = randomUid();
    await store(uid, PH_ALL, whole);
    const project: readonly Row[] = [["2026-09-14", 40, 0]];
    const publicId = await store(uid, PH, project);

    const svg = await render(publicId);

    expect(svg).toBe(expected(project, whole));
    // プロジェクトだけで四分位を取ると別の色になる
    expect(svg).not.toBe(expected(project, project));
  });

  it("**別の uid の行は、同じ ph でも混ざらない**", async () => {
    const other = randomUid();
    await store(other, PH_ALL, [["2026-09-14", 1000, 0]]);
    await store(other, PH, [["2026-09-13", 1000, 0]]);

    const uid = randomUid();
    const wholeId = await store(uid, PH_ALL, whole);
    const project: readonly Row[] = [["2026-09-14", 40, 0]];
    const projectId = await store(uid, PH, project);

    expect(await render(wholeId)).toBe(expected(whole.slice(1), whole, { total: true }));
    expect(await render(projectId)).toBe(expected(project, whole));
  });

  it("**合算の図にだけ、マスを重ねた印を描く** (合算かどうかは publicId が決める)", async () => {
    const uid = randomUid();
    const wholeId = await store(uid, PH_ALL, whole);
    const projectId = await store(uid, PH, [["2026-09-14", 40, 0]]);

    expect(await render(wholeId)).toContain('<g data-part="name"');
    expect(await render(wholeId)).toMatch(/<rect [^>]*width="7"/);
    expect(await render(projectId)).not.toMatch(/<rect [^>]*width="7"/);
  });

  it("**「今日」は日本時間で決める** (UTC の日付では右端の列が 1 日遅れる)", async () => {
    const publicId = await store(randomUid(), PH_ALL, whole);

    const svg = await render(publicId);

    expect(svg).not.toBe(expected(whole.slice(1), whole, { total: true, today: "2026-09-14" }));
  });

  it("**記録のある最も古い日より前のマスに計測開始の点線を出す** (Issue #80)", async () => {
    const publicId = await store(randomUid(), PH_ALL, [["2026-09-14", 40, 0]]);

    expect(await render(publicId)).toContain("stroke-dasharray");
  });

  it("**開始日は * の全期間から取る** (プロジェクト別で範囲の端を開始と取り違えない)", async () => {
    const uid = randomUid();
    // 合算は表示範囲より前から記録がある。プロジェクト別は表示範囲の中だけ
    await store(uid, PH_ALL, whole);
    const publicId = await store(uid, PH, [["2026-09-14", 40, 0]]);

    expect(await render(publicId)).not.toContain("stroke-dasharray");
  });

  it("graphs に無い publicId は undefined", async () => {
    expect(await render("0".repeat(32))).toBeUndefined();
  });

  it("D1 の失敗は throw する (呼ぶ側が 503 にする)", async () => {
    const db = {
      prepare: () => {
        throw new Error("D1_ERROR");
      },
    } as unknown as D1Database;
    await expect(render("0".repeat(32), {}, db)).rejects.toThrow();
  });
});

describe("GET /v1/g/{publicId}.svg — D1 の記録", () => {
  it("200 と、Cosense で表示されるのに要るヘッダ。ETag で 304 を返す", async () => {
    const publicId = await store(randomUid(), PH_ALL, [["2026-09-14", 5, 5]]);
    const res = await SELF.fetch(`https://example.com/v1/g/${publicId}.svg`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=900");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
    );
    expect((await res.text()).startsWith("<svg")).toBe(true);

    const etag = res.headers.get("etag") ?? "";
    const again = await SELF.fetch(`https://example.com/v1/g/${publicId}.svg`, {
      headers: { "if-none-match": etag },
    });
    expect(again.status).toBe(304);
  });

  it("**既定は 1 年 × 1 日。`card.svg` と `overview.svg` は半年 × 3 分割** (同じ記録を同じ描画で)", async () => {
    const publicId = await store(randomUid(), PH_ALL, [["2026-09-14", 5, 5]]);
    const fetchText = async (path: string) =>
      (await SELF.fetch(`https://example.com/v1/g/${publicId}${path}`)).text();

    const graph = await fetchText(".svg");
    expect(graph).toMatch(/^<svg [^>]*width="775" height="198"/);
    expect(await fetchText("/card.svg?span=year&cell=day")).toBe(graph);
    const card = await fetchText("/card.svg");
    expect(card).toMatch(/^<svg [^>]*width="500" height="400"/);
    expect(await fetchText("/overview.svg")).toBe(card);
  });

  it("描画のクエリが効く (未知のキーは無視する)", async () => {
    const publicId = await store(randomUid(), PH_ALL, [["2026-09-14", 5, 5]]);
    const fetchText = async (query: string) =>
      (await SELF.fetch(`https://example.com/v1/g/${publicId}.svg${query}`)).text();
    const base = await fetchText("");

    expect(await fetchText("?r=2")).toBe(base);
    expect(await fetchText("?theme=dark")).not.toBe(base);
  });

  it("**graphs に無い publicId と、形の違う publicId は 404**", async () => {
    for (const id of ["0".repeat(32), `${"ABCDEF".repeat(5)}AB`, "0".repeat(31), "../x"]) {
      for (const path of [`${id}.svg`, `${id}/card.svg`, `${id}/overview.svg`]) {
        const res = await SELF.fetch(`https://example.com/v1/g/${path}`);
        expect(res.status, path).toBe(404);
      }
    }
  });
});

describe("年を振り返る (Issue #128)", () => {
  it("**右端より後の記録は表示範囲に入らない**", async () => {
    const publicId = await store(randomUid(), PH_ALL, [
      ["2026-09-14", 40, 0],
      ["2025-03-01", 40, 0],
    ]);

    const past = await render(publicId, { end: "2025-03-01" });

    expect(past).not.toBe(await render(publicId));
  });

  it("**四分位と中心は全期間のまま** (過去を見ても現在と同じ物差しで塗る。ADR-0007 決定 4)", async () => {
    const rows: readonly Row[] = [
      ["2025-03-01", 10, 0],
      ["2026-09-10", 500, 0],
      ["2026-09-11", 500, 0],
      ["2026-09-12", 500, 0],
    ];
    const publicId = await store(randomUid(), PH_ALL, rows);

    const past = await render(publicId, { end: "2025-03-01" });

    // 範囲内だけで四分位を取っていたら、唯一の値である 10 分が最も濃い段になる。全期間から取るので薄い段のまま
    expect(past).toBe(expected(rows, rows, { total: true, end: "2025-03-01" }));
    expect(past).not.toBe(expected(rows, rows.slice(0, 1), { total: true, end: "2025-03-01" }));
  });
});
