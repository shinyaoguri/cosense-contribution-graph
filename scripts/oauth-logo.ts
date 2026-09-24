// Google の OAuth 同意画面に上げるロゴ (120×120 の PNG) を作る (Issue #141)。
//
//   node scripts/oauth-logo.ts [out]
//   npm run logo            # dist/oauth-logo.png
//
// **絵は favicon と同じ** (`src/shared/grass-icon.ts` の `synced`)。別の絵を持たず、ここでは描き直すだけにする。
// **画像はコミットしない** — 要るときにこのコマンドで作り直す。ロゴを差し替えると brand verification を
// やり直すことになるので (research §6)、grass-icon.ts の絵を変えても自動では上げ直さない。
//
// - Branding の制約は「1MB 以下、JPG / PNG / BMP、正方形で 120×120 が最もよく表示される」
// - **3×3 を中央の 80px に収める。** 円で切り抜かれても角のマスが欠けないよう、対角線 (約 113px) を 120px に収める
// - **背景は白で塗る。** 透過にすると、暗い背景の上でどう見えるかを Google 側の表示に委ねることになる
// - 依存を足さない。矩形 9 つだけなので、SVG の汎用のラスタライザは要らない。PNG は `node:zlib` で組む
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";
import { grassIconSvg } from "../src/shared/grass-icon.ts";

export const LOGO_SIZE = 120;

/** 3×3 の外側に空ける余白 (px)。 */
const PADDING = 20;

/** 1 px あたりの標本数の 1 辺。角の丸み (rx) の縁を滑らかにする。 */
const SUPERSAMPLE = 8;

const WHITE: Rgb = [255, 255, 255];

type Rgb = readonly [number, number, number];

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
  fill: Rgb;
}

/** grass-icon.ts が出す形の `<rect>` だけを読む。**塗りの無い矩形 (点線の枠) は読めない** — ロゴは `synced` だけを描く */
export function parseRects(svg: string): Rect[] {
  const pattern =
    /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)" fill="#([0-9a-f]{6})"\/>/g;
  return [...svg.matchAll(pattern)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    width: Number(m[3]),
    height: Number(m[4]),
    rx: Number(m[5]),
    fill: hexToRgb(m[6] ?? ""),
  }));
}

function hexToRgb(hex: string): Rgb {
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
}

/** 角の丸い矩形の内側か。 */
function contains(rect: Rect, u: number, v: number): boolean {
  if (u < rect.x || v < rect.y || u > rect.x + rect.width || v > rect.y + rect.height) {
    return false;
  }
  const cx = Math.min(Math.max(u, rect.x + rect.rx), rect.x + rect.width - rect.rx);
  const cy = Math.min(Math.max(v, rect.y + rect.rx), rect.y + rect.height - rect.rx);
  return (u - cx) ** 2 + (v - cy) ** 2 <= rect.rx ** 2;
}

/** 矩形の外接の箱を、画像の中央の `size - 2 * PADDING` px に写す。 */
export function renderPixels(rects: readonly Rect[], size = LOGO_SIZE): Uint8Array {
  if (rects.length === 0) {
    throw new Error("塗りのある <rect> が 1 つも無い");
  }
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const extent = Math.max(
    ...rects.map((r) => r.x + r.width - left),
    ...rects.map((r) => r.y + r.height - top),
  );
  const scale = (size - 2 * PADDING) / extent;
  const pixels = new Uint8Array(size * size * 3);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let [r, g, b] = [0, 0, 0];
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const u = left + (px + (sx + 0.5) / SUPERSAMPLE - PADDING) / scale;
          const v = top + (py + (sy + 0.5) / SUPERSAMPLE - PADDING) / scale;
          const color = rects.find((rect) => contains(rect, u, v))?.fill ?? WHITE;
          r += color[0];
          g += color[1];
          b += color[2];
        }
      }
      const samples = SUPERSAMPLE ** 2;
      pixels.set(
        [r, g, b].map((sum) => Math.round(sum / samples)),
        (py * size + px) * 3,
      );
    }
  }
  return pixels;
}

/** 8 bit の RGB (色型 2) の PNG にする。フィルタは各行とも None。 */
export function encodePng(pixels: Uint8Array, size: number): Uint8Array {
  const stride = size * 3;
  const raw = new Uint8Array(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

export function renderLogo(): Uint8Array {
  return encodePng(renderPixels(parseRects(grassIconSvg("synced"))), LOGO_SIZE);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = concat([new TextEncoder().encode(type), data]);
  const out = new Uint8Array(body.length + 8);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(body.length + 4, crc32(body));
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function main(): Promise<void> {
  const out = process.argv[2] ?? "dist/oauth-logo.png";
  const png = renderLogo();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, png);
  console.log(`${out}: ${LOGO_SIZE}×${LOGO_SIZE} PNG、${png.length} バイト`);
}

// CLI として起動したときだけ走らせる (テストから import しても何もしない)
if (process.argv[1]?.endsWith("oauth-logo.ts")) {
  main().catch((error: unknown) => {
    console.error(`NG: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
