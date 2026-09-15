import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEMO_PUBLIC_ID } from "../../src/worker/svg.ts";

const ORIGIN = "https://example.com";

async function fetchPage(path: string): Promise<{ res: Response; html: string }> {
  const res = await SELF.fetch(`${ORIGIN}${path}`);
  return { res, html: await res.text() };
}

describe("トップ /", () => {
  it("**導入の 1 行とデモの草を出す**", async () => {
    const { res, html } = await fetchPage("/");

    expect(res.status).toBe(200);
    expect(html).toContain('import "/api/code/cosense-grass/v1/script.js"');
    expect(html).toContain(`/v1/g/${DEMO_PUBLIC_ID}.svg`);
    expect(html).toContain("/account");
    expect(html).toContain("/privacy");
  });

  it("**スクリプトを載せず、CSP で止める**", async () => {
    const { res, html } = await fetchPage("/");

    expect(html).not.toContain("<script");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'none'");
    // 草の SVG は同じオリジンから
    expect(csp).toContain("img-src 'self'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("**中身はデプロイでしか変わらないのでキャッシュする**", async () => {
    const { res } = await fetchPage("/");

    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });
});

describe("プライバシーポリシー /privacy", () => {
  it("**docs/privacy.md を HTML にして出す** (文面を 2 か所に置かない)", async () => {
    const { res, html } = await fetchPage("/privacy");

    expect(res.status).toBe(200);
    expect(html).toContain("<h1>プライバシーポリシー</h1>");
    // 正本にある節と表が出る
    expect(html).toContain("<h2>保存しないもの</h2>");
    expect(html).toContain("<table>");
    expect(html).toContain("<code>__Host-grass-auth</code>");
    // 草案の但し書きは消えている (配信するので)
    expect(html).not.toContain("草案");
  });

  it("正本のリンクは a になる", async () => {
    const { html } = await fetchPage("/privacy");

    expect(html).toContain('<a href="https://github.com/shinyaoguri/cosense-contribution-graph"');
  });
});

describe("それ以外", () => {
  it("知らないパスは 404 のまま", async () => {
    const { res } = await fetchPage("/nope");

    expect(res.status).toBe(404);
  });
});
