import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import ledger from "../../docs/readme-images.json";

const ORIGIN = "https://example.com";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// README の画像は Gyazo に置いた PNG で、リポジトリには台帳 (docs/readme-images.json) だけがある。
// **いまのコードが描く SVG と、撮ったときの SVG を突き合わせる** — 描画を変えたのに撮り直していないと落ちる。
// 画像そのものは比べないので、Gyazo にも外部にも触らない
describe("README の画像の鮮度 (docs/readme-images.json)", () => {
  it.each(ledger.images.map((image) => [image.name, image] as const))(
    "**%s は撮ったときと同じ絵** (違えば npm run dev を起動して npm run readme-images で撮り直す)",
    async (_name, image) => {
      const res = await SELF.fetch(`${ORIGIN}${image.path}`);
      expect(res.status).toBe(200);

      expect(await sha256Hex(await res.text())).toBe(image.sha256);
    },
  );
});
