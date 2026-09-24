import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { LOGO_SIZE, parseRects, renderLogo, renderPixels } from "../../scripts/oauth-logo.ts";
import { grassIconSvg } from "../../src/shared/grass-icon.ts";

/** encodePng の出力 (RGB・フィルタ None・IDAT 1 つ) を読み戻す。 */
function decode(png: Uint8Array): {
  width: number;
  height: number;
  pixel: (x: number, y: number) => string;
} {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const idatLength = view.getUint32(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  const stride = width * 3 + 1;
  const pixel = (x: number, y: number) =>
    `#${[0, 1, 2].map((i) => (raw[y * stride + 1 + x * 3 + i] ?? 0).toString(16).padStart(2, "0")).join("")}`;
  return { width, height, pixel };
}

describe("OAuth 同意画面のロゴ", () => {
  it("**120×120 の PNG** (Branding が勧める大きさ) で 1MB に遠く収まる", () => {
    const png = renderLogo();

    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { width, height } = decode(png);
    expect([width, height]).toEqual([120, 120]);
    expect(png.length).toBeLessThan(10_000);
  });

  it("**favicon と同じ絵** — 中央のマスは synced の最も濃い紫、四隅は白", () => {
    const { pixel } = decode(renderLogo());

    expect(pixel(60, 60)).toBe("#5b21b6");
    for (const [x, y] of [
      [0, 0],
      [119, 0],
      [0, 119],
      [119, 119],
    ] as const) {
      expect(pixel(x, y)).toBe("#ffffff");
    }
  });

  it("**円で切り抜かれても欠けない** — 白でない画素は内接円の内側だけ", () => {
    const pixels = renderPixels(parseRects(grassIconSvg("synced")));
    const center = (LOGO_SIZE - 1) / 2;
    const outside: string[] = [];
    for (let y = 0; y < LOGO_SIZE; y++) {
      for (let x = 0; x < LOGO_SIZE; x++) {
        const i = (y * LOGO_SIZE + x) * 3;
        const white = pixels[i] === 255 && pixels[i + 1] === 255 && pixels[i + 2] === 255;
        if (!white && Math.hypot(x - center, y - center) > LOGO_SIZE / 2) {
          outside.push(`${x},${y}`);
        }
      }
    }

    expect(outside).toEqual([]);
  });

  it("塗りの無い絵 (点線の枠) は描けないと言って止まる", () => {
    expect(() => renderPixels(parseRects(grassIconSvg("not-installed")))).toThrow("<rect>");
  });
});
