import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { centerOf, hueOf } from "../../src/shared/balance.ts";
import { levelColor } from "../../src/shared/color.ts";
import { DEFAULT_PARAMS, MAX_WEEKS } from "../../src/shared/graph.ts";
import { buildScale } from "../../src/shared/scale.ts";
import { DEMO_TODAY, demoData } from "../../src/worker/demo.ts";
import { renderGraph } from "../../src/worker/svg.ts";

const DEMO_URL = "https://example.com/v1/g/demo.svg";

function fetchDemo(query = "", init?: RequestInit) {
  return SELF.fetch(`${DEMO_URL}${query}`, init);
}

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

/** `<g data-part="...">` の中身。グループは入れ子にしていない。 */
function part(svg: string, name: string): string {
  return new RegExp(`<g data-part="${name}"[^>]*>(.*?)</g>`).exec(svg)?.[1] ?? "";
}

function fills(fragment: string): string[] {
  return [...fragment.matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1] ?? "");
}

function rectCount(fragment: string): number {
  return fragment.match(/<rect\b/g)?.length ?? 0;
}

describe("GET /v1/g/demo.svg の応答", () => {
  it("200 と、Cosense で表示されるのに要るヘッダ", async () => {
    const res = await fetchDemo();

    expect(res.status).toBe(200);
    // これが無いと Cosense で表示されない (research §3 で過去に踏まれた唯一の落とし穴)
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=900");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("HEAD でも 200 を返す", async () => {
    expect((await fetchDemo("", { method: "HEAD" })).status).toBe(200);
  });
});

describe("ETag (本文の SHA-256、ADR-0015 決定 2)", () => {
  it("強い ETag を付ける", async () => {
    const res = await fetchDemo();

    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it("If-None-Match が一致すれば 304。ETag と Cache-Control を付け、本文は空", async () => {
    const etag = (await fetchDemo()).headers.get("etag") ?? "";

    const res = await fetchDemo("", { headers: { "if-none-match": etag } });

    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("public, max-age=900");
    expect(await res.text()).toBe("");
  });

  it("弱い比較: W/ 付きでも一致とみなす (Cloudflare が圧縮時に弱い ETag に変えることがある)", async () => {
    const etag = (await fetchDemo()).headers.get("etag") ?? "";

    const res = await fetchDemo("", { headers: { "if-none-match": `W/${etag}` } });

    expect(res.status).toBe(304);
  });

  it("一致しなければ 200", async () => {
    const res = await fetchDemo("", { headers: { "if-none-match": '"0000"' } });

    expect(res.status).toBe(200);
  });

  it("描画が変わると ETag も変わる (テーマを変えた場合)", async () => {
    const light = (await fetchDemo()).headers.get("etag");
    const dark = (await fetchDemo("?theme=dark")).headers.get("etag");

    expect(dark).not.toBe(light);
  });
});

describe("クエリ (design §6)", () => {
  it("不正な値と範囲外は既定値に落とす (ETag が既定と同じになる)", async () => {
    const defaultEtag = (await fetchDemo()).headers.get("etag");

    for (const query of [
      "?theme=blue",
      "?mode=read",
      "?weeks=0",
      "?weeks=54",
      "?weeks=10abc",
      "?weeks=-3",
      "?unknown=1",
    ]) {
      expect((await fetchDemo(query)).headers.get("etag"), query).toBe(defaultEtag);
    }
  });

  it("範囲内の weeks は反映する", async () => {
    const svg = await (await fetchDemo("?weeks=10")).text();

    expect(rectCount(part(svg, "grid"))).toBe(7 * 9 + 1);
  });
});

describe("存在しない経路は 404 (design §6)", () => {
  it("demo 以外の publicId", async () => {
    expect((await SELF.fetch("https://example.com/v1/g/unknown.svg")).status).toBe(404);
  });

  it("拡張子が違う", async () => {
    expect((await SELF.fetch("https://example.com/v1/g/demo.png")).status).toBe(404);
  });

  it("GET と HEAD 以外", async () => {
    expect((await fetchDemo("", { method: "POST" })).status).toBe(404);
  });
});

describe("SVG の構造", () => {
  it("ルート要素に xmlns / width / height / viewBox を持ち、viewBox が寸法に一致する", async () => {
    const attrs = rootAttributes(await (await fetchDemo()).text());

    expect(attrs.xmlns).toBe("http://www.w3.org/2000/svg");
    expect(attrs.viewBox).toBe(`0 0 ${attrs.width} ${attrs.height}`);
  });

  it(`格子は 365 マス、凡例は 5 列 × 4 行 = 20 マス`, async () => {
    const svg = await (await fetchDemo()).text();

    expect(rectCount(part(svg, "grid"))).toBe(365);
    expect(rectCount(part(svg, "legend"))).toBe(20);
  });

  it("write の凡例は 1 行 × 4 マス (色相が固定なので 2 次元にしない)", async () => {
    const svg = await (await fetchDemo("?mode=write")).text();

    expect(rectCount(part(svg, "grid"))).toBe(365);
    expect(rectCount(part(svg, "legend"))).toBe(4);
  });

  it("月と曜日と凡例の軸のラベルを日本語で出す", async () => {
    const labels = part(await (await fetchDemo()).text(), "labels");

    for (const text of ["9月", "1月", "月", "水", "金", "読む", "書く", "少ない", "多い"]) {
      expect(labels).toContain(`>${text}</text>`);
    }
  });

  it("CSS の oklch() も外部参照も含まない (design §7 / §8)", async () => {
    const svg = await (await fetchDemo()).text();

    expect(svg).not.toMatch(/oklch\(/);
    expect(svg).not.toMatch(/href=|url\(|@import/);
  });
});

describe("凡例の意味", () => {
  it("左上は Level 1 の読み寄り、右下は Level 4 の書き寄り", async () => {
    const legend = fills(part(await (await fetchDemo()).text(), "legend"));

    // 凡例のマスは彩度を飽和させる (割合 1)
    expect(legend[0]).toBe(levelColor(1, 1, hueOf(-1), "light"));
    expect(legend[4]).toBe(levelColor(1, 1, hueOf(1), "light"));
    expect(legend[15]).toBe(levelColor(4, 1, hueOf(-1), "light"));
    expect(legend[19]).toBe(levelColor(4, 1, hueOf(1), "light"));
  });

  it("dark の凡例は dark のランプで塗る", async () => {
    const legend = fills(part(await (await fetchDemo("?theme=dark")).text(), "legend"));

    expect(legend[19]).toBe(levelColor(4, 1, hueOf(1), "dark"));
  });
});

describe("表示範囲と母集団を取り違えない (design §7)", () => {
  it("四分位を母集団 (全期間) から取った SVG と、表示範囲だけから取った SVG は違う", () => {
    const { days, population } = demoData();
    const params = DEFAULT_PARAMS;
    const center = centerOf(population);

    const fromPopulation = renderGraph({
      today: DEMO_TODAY,
      days,
      scale: buildScale(population.map((d) => d.w + d.r)),
      center,
      params,
    });
    const fromDisplayOnly = renderGraph({
      today: DEMO_TODAY,
      days,
      scale: buildScale([...days.values()].map((d) => d.w + d.r)),
      center,
      params,
    });

    // デモは表示範囲より古い日を分布を変えて母集団に入れてあるので、取り違えると色が変わる
    expect(fromPopulation).not.toBe(fromDisplayOnly);
  });

  it("経路は母集団 (全期間) から取った四分位で描く", async () => {
    const { days, population } = demoData();
    const expected = renderGraph({
      today: DEMO_TODAY,
      days,
      scale: buildScale(population.map((d) => d.w + d.r)),
      center: centerOf(population),
      params: DEFAULT_PARAMS,
    });

    expect(await (await fetchDemo()).text()).toBe(expected);
  });

  it("weeks が小さいと全体の幅は凡例で決まる", () => {
    const { days, population } = demoData();
    const svg = renderGraph({
      today: DEMO_TODAY,
      days,
      scale: buildScale(population.map((d) => d.w + d.r)),
      center: centerOf(population),
      params: { ...DEFAULT_PARAMS, weeks: 1 },
    });

    expect(Number(rootAttributes(svg).width)).toBeGreaterThan(8 * 2 + 20 + 11);
    expect(MAX_WEEKS).toBe(53);
  });
});
