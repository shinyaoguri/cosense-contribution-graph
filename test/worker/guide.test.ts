import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GUIDE_HEIGHTS, GUIDE_NAMES, GUIDE_WIDTH } from "../../src/shared/guide.ts";
import { DEFAULT_SCHEME, schemeOf } from "../../src/worker/graph/scheme.ts";
import { cellColor } from "../../src/worker/guide-svg.ts";

const ORIGIN = "https://example.com";

const fetchGuide = (name: string) => SELF.fetch(`${ORIGIN}/v1/guide/${name}.svg`);

describe("GET /v1/guide/{name}.svg (Issue #182)", () => {
  it.each(GUIDE_NAMES)(
    "**%s は SVG で返し、毎回 ETag で確かめ直させる** (デプロイで図を変えたらすぐ替わる。#186)",
    async (name) => {
      const res = await fetchGuide(name);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("public, no-cache");
    },
  );

  it("**クエリは無視して同じ図を返す** (UserScript が古いキャッシュを避けるために `?v=` を付ける。#186)", async () => {
    const plain = await (await fetchGuide("grass")).text();
    const res = await SELF.fetch(`${ORIGIN}/v1/guide/grass.svg?v=2`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(plain);
  });

  it("**確かめ直しは ETag で 304 を返す** (図が変わっていなければ本文を送らない)", async () => {
    const etag = (await fetchGuide("grass")).headers.get("etag") ?? "";
    expect(etag).not.toBe("");

    const again = await SELF.fetch(`${ORIGIN}/v1/guide/grass.svg`, {
      headers: { "if-none-match": etag },
    });

    expect(again.status).toBe(304);
    expect(again.headers.get("cache-control")).toBe("public, no-cache");
  });

  it.each(GUIDE_NAMES)(
    "**%s の寸法は `shared/guide.ts` のとおり** (UserScript が `<img>` に先に確保する寸法。ずれると縦横比が崩れる)",
    async (name) => {
      const body = await (await fetchGuide(name)).text();
      const height = GUIDE_HEIGHTS[name];

      expect(
        body.startsWith(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${GUIDE_WIDTH}" height="${height}" viewBox="0 0 ${GUIDE_WIDTH} ${height}">`,
        ),
      ).toBe(true);
    },
  );

  it("**知らない名前は 404**", async () => {
    for (const name of ["unknown", "toString", "__proto__", "grass.svg"]) {
      const res = await fetchGuide(name);
      expect(res.status, name).toBe(404);
    }
  });

  it("**色の読み方の表は、実際の草と同じ配色の色で塗る** (配色を変えたら図も追従する)", async () => {
    const body = await (await fetchGuide("grass")).text();
    const key = /<g data-part="key">(.*?)<\/g>/.exec(body)?.[1] ?? "";
    const fills = [...key.matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
    const scheme = schemeOf(DEFAULT_SCHEME);
    const expected = ([4, 3, 2, 1] as const).flatMap((level) =>
      scheme.legendBalances.map((balance) => cellColor(level, balance)),
    );

    expect(fills).toEqual(expected);
    // 濃さ 4 段 × 色合いの列。**同じ色が 2 つ無い** (見分けられない見本を並べない)
    expect(new Set(fills).size).toBe(4 * scheme.legendBalances.length);
  });

  it("**概観の図は、実物の概観と同じレイアウトで例の割合を描く**", async () => {
    const body = await (await fetchGuide("overview")).text();

    // 読む 240 / 育てる 90 / 関わる 40 / 作る 30 (合計 400)
    for (const [name, percent] of [
      ["読む", 60],
      ["育てる", 22],
      ["関わる", 10],
      ["作る", 8],
    ] as const) {
      expect(body).toContain(`${name}<tspan dx="4" font-weight="bold">${percent}%</tspan>`);
    }
  });

  it("**数えているものの図の合計は、帯のマスの数と合う** (書いた 6 + 読んだ 9 = 15)", async () => {
    const body = await (await fetchGuide("minutes")).text();
    const strip = /<g data-part="minutes">(.*?)<\/g>/.exec(body)?.[1] ?? "";
    const scheme = schemeOf(DEFAULT_SCHEME);
    const balances = scheme.legendBalances;
    const write = cellColor(3, balances[balances.length - 1] ?? 1);
    const read = cellColor(3, balances[0] ?? -1);
    const count = (color: string) => strip.split(`fill="${color}"`).length - 1;

    expect(count(write)).toBe(6);
    expect(count(read)).toBe(9);
    expect(strip.split('stroke-dasharray="2 2"').length - 1).toBe(5);
    expect(body).toContain("書いた 6 分");
    expect(body).toContain("読んだ 9 分");
    expect(body).toContain("この 20 分の活動は 15 分");
  });
});
