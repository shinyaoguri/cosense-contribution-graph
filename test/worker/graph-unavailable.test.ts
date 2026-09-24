import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// D1 はテストファイル単位で分かれるので、テーブルを壊すこのテストは別のファイルに置く

describe("GET /v1/g/{publicId}.svg — D1 が読めない", () => {
  it("**503 で、キャッシュさせない** (壊れた画像を 15 分残さない)", async () => {
    await env.DB.prepare("DROP TABLE graphs").run();

    const res = await SELF.fetch(`https://example.com/v1/g/${"0".repeat(32)}.svg`);

    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("**日ごとの数値の JSON も 503 で、キャッシュさせない**", async () => {
    const res = await SELF.fetch(
      `https://example.com/v1/g/${"0".repeat(32)}/${"0".repeat(32)}.json`,
    );

    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("デモは D1 を使わないので描ける", async () => {
    const res = await SELF.fetch("https://example.com/v1/g/demo.svg");
    expect(res.status).toBe(200);
  });
});
