import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { grassIconSvg } from "../../src/shared/grass-icon.ts";
import { FAVICON_LINK, FAVICON_PATH } from "../../src/worker/favicon.ts";

const ORIGIN = "https://example.com";

describe("GET /favicon.svg", () => {
  it("**Cosense のボタンの `synced` と同じ絵を SVG で返す**", async () => {
    const res = await SELF.fetch(`${ORIGIN}${FAVICON_PATH}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(grassIconSvg("synced"));
  });

  it("**絵が固定なので草より長くキャッシュし、ETag で 304 を返す**", async () => {
    const first = await SELF.fetch(`${ORIGIN}${FAVICON_PATH}`);
    const etag = first.headers.get("etag") ?? "";

    expect(first.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);

    const second = await SELF.fetch(`${ORIGIN}${FAVICON_PATH}`, {
      headers: { "if-none-match": etag },
    });

    expect(second.status).toBe(304);
    expect(second.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  it("**草のキャッシュは変えない** (favicon のために 15 分を延ばさない)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/g/demo.svg`);

    expect(res.headers.get("cache-control")).toBe("public, max-age=900");
  });

  it("**`/favicon.ico` は 404 のまま** (中身が SVG なのに `.ico` を名乗らせない)", async () => {
    const res = await SELF.fetch(`${ORIGIN}/favicon.ico`);

    expect(res.status).toBe(404);
  });

  it("POST は受けない", async () => {
    const res = await SELF.fetch(`${ORIGIN}${FAVICON_PATH}`, { method: "POST" });

    expect(res.status).toBe(404);
  });
});

describe("ページの <head>", () => {
  it("**`/` と `/privacy` が favicon を指し、CSP がそれを通す**", async () => {
    for (const path of ["/", "/privacy"]) {
      const res = await SELF.fetch(`${ORIGIN}${path}`);

      expect(await res.text()).toContain(FAVICON_LINK);
      expect(res.headers.get("content-security-policy")).toContain("img-src 'self'");
    }
  });

  it("同じオリジンのパスを指す (data: URI は `img-src 'self'` で落ちる)", () => {
    expect(FAVICON_LINK).toBe('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
  });
});
