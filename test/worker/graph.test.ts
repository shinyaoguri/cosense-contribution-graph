import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DAYS, renderDemoSvg, WEEKS } from "../../src/worker/svg.ts";

const DEMO_URL = "https://example.com/v1/g/demo.svg";

/** ルート要素の属性を取り出す。workerd には DOMParser が無いので正規表現で見る。 */
function rootAttributes(svg: string): Record<string, string> {
  const open = /^<svg\b([^>]*)>/.exec(svg);
  if (!open?.[1]) {
    throw new Error("ルート要素が <svg で始まっていない");
  }
  return Object.fromEntries(
    [...open[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
}

describe("GET /v1/g/demo.svg", () => {
  it("200 で返す", async () => {
    const res = await SELF.fetch(DEMO_URL);

    expect(res.status).toBe(200);
  });

  it("Content-Type が image/svg+xml; charset=utf-8", async () => {
    // これが無いと Cosense で表示されない (research §3 で過去に踏まれた唯一の落とし穴)
    const res = await SELF.fetch(DEMO_URL);

    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
  });

  it("キャッシュとセキュリティのヘッダを付ける", async () => {
    const res = await SELF.fetch(DEMO_URL);

    expect(res.headers.get("cache-control")).toBe("public, max-age=900");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("HEAD でも 200 を返す", async () => {
    // curl -I で確かめられるように
    const res = await SELF.fetch(DEMO_URL, { method: "HEAD" });

    expect(res.status).toBe(200);
  });
});

describe("存在しない経路", () => {
  it("demo 以外の publicId は 404", async () => {
    // docs に規定が無かったので 404 と決めた (ADR-0014)
    const res = await SELF.fetch("https://example.com/v1/g/unknown.svg");

    expect(res.status).toBe(404);
  });

  it("拡張子が違えば 404", async () => {
    const res = await SELF.fetch("https://example.com/v1/g/demo.png");

    expect(res.status).toBe(404);
  });

  it("GET と HEAD 以外は 404", async () => {
    const res = await SELF.fetch(DEMO_URL, { method: "POST" });

    expect(res.status).toBe(404);
  });
});

describe("デモの SVG", () => {
  it("ルート要素に xmlns / width / height / viewBox を持つ", () => {
    // 3 つが欠けると Cosense でサイズが崩れる。xmlns が無いと <img> で描画されない
    const attrs = rootAttributes(renderDemoSvg());

    expect(attrs.xmlns).toBe("http://www.w3.org/2000/svg");
    expect(attrs.width).toBeDefined();
    expect(attrs.height).toBeDefined();
    expect(attrs.viewBox).toBeDefined();
  });

  it("viewBox が width と height に一致する", () => {
    // ずれると拡大縮小で格子が歪む
    const attrs = rootAttributes(renderDemoSvg());

    expect(attrs.viewBox).toBe(`0 0 ${attrs.width} ${attrs.height}`);
  });

  it("53 週 × 7 日 = 371 マスある", () => {
    const cells = renderDemoSvg().match(/<rect\b/g) ?? [];

    expect(cells).toHaveLength(WEEKS * DAYS);
    expect(WEEKS * DAYS).toBe(371);
  });

  it("CSS の oklch() も外部参照も含まない", () => {
    // <img> 経由の SVG は外部を読めず、oklch() はブラウザ依存が読めない (design §7 / §8)
    const svg = renderDemoSvg();

    expect(svg).not.toMatch(/oklch\(/);
    expect(svg).not.toMatch(/href=|url\(|@import/);
  });
});
