import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CARD_FORM, GRAPH_FORM, GRASS_SIZES } from "../../src/shared/grass.ts";

/**
 * 図の経路 (ADR-0026 決定 6)。`{publicId}.svg`・`card.svg`・`overview.svg` は同じ描画で、**既定の形だけが違う**。
 * 描画そのもの (マス・色・線) は `graph/grass.test.ts`、D1 から読むところは `graph-data.test.ts` と `card.test.ts` が見る
 */
const ORIGIN = "https://example.com";
const GRAPH_URL = `${ORIGIN}/v1/g/demo.svg`;
const CARD_URL = `${ORIGIN}/v1/g/demo/card.svg`;
const OVERVIEW_URL = `${ORIGIN}/v1/g/demo/overview.svg`;
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const fetchText = async (url: string, init?: RequestInit) => (await SELF.fetch(url, init)).text();

/** ルート要素の属性。workerd には DOMParser が無いので正規表現で見る。 */
function rootAttributes(svg: string): Record<string, string> {
  const open = /^<svg\b([^>]*)>/.exec(svg);
  if (!open?.[1]) {
    throw new Error("ルート要素が <svg で始まっていない");
  }
  return Object.fromEntries(
    [...open[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
}

/** SVG の月ラベルを左から順に読む */
function monthLabels(svg: string): string[] {
  return [...svg.matchAll(/>(\d{1,2}月)<\/text>/g)].map((m) => m[1] ?? "");
}

describe("既定の形は経路ごとに違い、描画は同じ (ADR-0026 決定 6)", () => {
  it("**`{publicId}.svg` の既定は 1 年 × 1 日** (貼ってある草の意味を保つ)", async () => {
    expect(await fetchText(GRAPH_URL)).toBe(await fetchText(`${CARD_URL}?span=year&cell=day`));
    const { width, height } = GRASS_SIZES[GRAPH_FORM.span][GRAPH_FORM.cell];
    expect(rootAttributes(await fetchText(GRAPH_URL))).toMatchObject({
      xmlns: "http://www.w3.org/2000/svg",
      width: String(width),
      height: String(height),
      viewBox: `0 0 ${width} ${height}`,
    });
  });

  it("**`overview.svg` は廃止し、`card.svg` の既定を返す** (貼ったページで画像を壊さない)", async () => {
    expect(await fetchText(OVERVIEW_URL)).toBe(await fetchText(CARD_URL));
    const { width, height } = GRASS_SIZES[CARD_FORM.span][CARD_FORM.cell];
    expect(rootAttributes(await fetchText(OVERVIEW_URL))).toMatchObject({
      width: String(width),
      height: String(height),
    });
  });

  it("**どの経路も同じクエリを受ける**", async () => {
    expect(await fetchText(`${GRAPH_URL}?span=half&cell=slot&theme=dark`)).toBe(
      await fetchText(`${CARD_URL}?theme=dark`),
    );
    expect(await fetchText(`${OVERVIEW_URL}?span=year&cell=day`)).toBe(await fetchText(GRAPH_URL));
  });

  it("**weeks は読まない** (貼ってある `weeks=26` の草も 1 年で描く)", async () => {
    expect(await fetchText(`${GRAPH_URL}?weeks=26`)).toBe(await fetchText(GRAPH_URL));
  });
});

describe.each([GRAPH_URL, CARD_URL, OVERVIEW_URL])("%s の応答", (url) => {
  it("200 と、Cosense で表示されるのに要るヘッダ。**CSP はアイコンの `data:` だけを許す**", async () => {
    const res = await SELF.fetch(url);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=900");
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("HEAD でも 200 を返す", async () => {
    expect((await SELF.fetch(url, { method: "HEAD" })).status).toBe(200);
  });

  it("CSS の oklch() も外部参照も含まない (design §7 / §8)", async () => {
    const svg = await fetchText(url);

    expect(svg).not.toContain("oklch");
    expect(svg).not.toMatch(/(?:href|src)="https?:\/\/(?!scrapbox\.io\/)/);
    expect(svg).not.toContain("<style");
  });
});

describe("ETag (本文の SHA-256、ADR-0015 決定 2)", () => {
  it("強い ETag を付け、If-None-Match が一致すれば 304。ETag と Cache-Control を付け、本文は空", async () => {
    const etag = (await SELF.fetch(GRAPH_URL)).headers.get("etag") ?? "";
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);

    const again = await SELF.fetch(GRAPH_URL, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("cache-control")).toBe("public, max-age=900");
    expect(await again.text()).toBe("");
  });

  it("弱い比較: W/ 付きでも一致とみなす (Cloudflare が圧縮時に弱い ETag に変えることがある)", async () => {
    const etag = (await SELF.fetch(GRAPH_URL)).headers.get("etag") ?? "";
    const res = await SELF.fetch(GRAPH_URL, { headers: { "if-none-match": `W/${etag}` } });
    expect(res.status).toBe(304);
  });

  it("一致しなければ 200。描画が変わると ETag も変わる", async () => {
    const light = (await SELF.fetch(GRAPH_URL)).headers.get("etag");
    const res = await SELF.fetch(`${GRAPH_URL}?theme=dark`, {
      headers: { "if-none-match": light ?? "" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).not.toBe(light);
  });
});

describe("クエリ (design §6)", () => {
  it("**不正な値は既定に落とす** (400 にしない。ETag が既定と同じになる)", async () => {
    const base = (await SELF.fetch(GRAPH_URL)).headers.get("etag");

    for (const query of [
      "?theme=blue",
      "?mode=read",
      "?palette=nope",
      "?palette=toString",
      "?span=month",
      "?cell=hour",
      "?lang=fr",
      "?weeks=0",
      "?unknown=1",
    ]) {
      const res = await SELF.fetch(`${GRAPH_URL}${query}`);
      expect(res.status, query).toBe(200);
      expect(res.headers.get("etag"), query).toBe(base);
    }
  });

  it("既定の配色を palette で明示しても同じ画像", async () => {
    expect(await fetchText(`${GRAPH_URL}?palette=violet-amber`)).toBe(await fetchText(GRAPH_URL));
  });

  it("**`l` でプロジェクト名を描き、プロジェクトへのリンクを埋める** (`<img>` では押せないが、画像を開けば飛べる)", async () => {
    const svg = await fetchText(`${GRAPH_URL}?l=villagepump`);

    expect(svg).toContain(">/villagepump</text>");
    expect(svg).toContain('<a href="https://scrapbox.io/villagepump/">');
  });

  it("**形の違うプロジェクト名は描かない** (エラーにはせず、名前だけ落とす)", async () => {
    const res = await SELF.fetch(`${GRAPH_URL}?l=${encodeURIComponent('"><script>')}`);

    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("script");
  });
});

describe("年を振り返る (Issue #128)", () => {
  it("**`?year=` でその年の 12/31 を右端にし、1 月から 12 月までの月ラベルが並ぶ**", async () => {
    const past = await fetchText(`${GRAPH_URL}?year=2025`);

    expect(monthLabels(past)).toEqual([
      "1月",
      "2月",
      "3月",
      "4月",
      "5月",
      "6月",
      "7月",
      "8月",
      "9月",
      "10月",
      "11月",
      "12月",
    ]);
    expect(past).not.toBe(await fetchText(GRAPH_URL));
  });

  it("**`card.svg` でも year は 1 年の期間になる** (span によらない)", async () => {
    expect(await fetchText(`${CARD_URL}?year=2025&cell=day`)).toBe(
      await fetchText(`${GRAPH_URL}?year=2025`),
    );
  });

  it("**記録より前の年を指定すると、塗られたマスが 1 つも無くなる** (右端が本当に動いている)", async () => {
    const svg = await fetchText(`${GRAPH_URL}?year=2020`);

    // デモの記録は 2026 年まで。2020 年の 53 週には 1 日も無いので、格子は空きマスの色だけ
    const grid = /<g data-part="grid">(.*?)<\/g>/s.exec(svg)?.[1] ?? "";
    const gridFills = new Set([...grid.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]));
    expect([...gridFills]).toEqual(["#eff1f4"]);
  });

  it("**今年と未来の年は今日が右端になる**。形の違う値も今日に落とす (400 にはしない)", async () => {
    const now = await fetchText(GRAPH_URL);

    for (const raw of ["2026", "2099", "abc", "20", "20255", "2025-03", ""]) {
      const res = await SELF.fetch(`${GRAPH_URL}?year=${encodeURIComponent(raw)}`);
      expect(res.status, raw).toBe(200);
      expect(await res.text(), raw).toBe(now);
    }
  });
});

describe("存在しない経路は 404 (design §6)", () => {
  it("demo 以外の形の違う publicId・拡張子が違う・経路が深い", async () => {
    for (const path of [
      "/v1/g/unknown.svg",
      "/v1/g/unknown/card.svg",
      "/v1/g/demo.png",
      "/v1/g/demo/other.svg",
      "/v1/g/demo/card.svg/x",
    ]) {
      expect((await SELF.fetch(`${ORIGIN}${path}`)).status, path).toBe(404);
    }
  });

  it("GET と HEAD 以外", async () => {
    expect((await SELF.fetch(GRAPH_URL, { method: "POST" })).status).toBe(404);
  });
});
