// README の画像を Worker が描く SVG から作り、Gyazo へ上げて README に書き戻す。
//
//   npm run dev                      # 別の端末で。撮るのは手元の Worker が描いた絵
//   npm run readme-images [-- --force]
//
// **画像はリポジトリに置かない。** 台帳 `docs/readme-images.json` に、何を (Worker のパス)・
// どの絵から (SVG 本文の SHA-256) 撮って・どこに上げたか (Gyazo の URL) だけを持つ。
//
// - **README の画像行は手で書かない。** `<!-- readme-image: <name> -->` の次の行の `<img>` を、
//   このスクリプトが台帳から書き戻す (撮り直すたびに本文と画像の対応がずれないように)
// - **撮り直すのは SVG が変わったものだけ** (`--force` で全部)。古い URL は Gyazo から消さない —
//   過去のリビジョンの README を開けば当時の絵が出る
// - 描画を変えたのに撮り直していないことは `test/worker/readme-images.test.ts` が CI で捕まえる
//   (台帳の SHA-256 と、いまのコードが描く SVG を突き合わせる。画像そのものは比べない)
//
// PNG にするのは `rsvg-convert` (`brew install librsvg`)。2 倍の解像度で、白地と余白を付ける —
// SVG は背景が透明なので、そのままでは GitHub のダークモードで文字が読めない。
// Gyazo のトークンは `GYAZO_ACCESS_TOKEN`、無ければ `secret-read gyazo-token` から読む。
// **CI では走らせない** (トークンを Secrets に置かない)。
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const LEDGER_PATH = "docs/readme-images.json";
export const README_PATH = "README.md";

/** `npm run dev` (wrangler dev) の既定 */
const DEFAULT_ORIGIN = "http://localhost:8787";

/** 絵の周りの白い余白 (SVG の px) */
export const PADDING = 16;

/** PNG の倍率。GitHub は `<img width>` で縮めて表示するので、高密度の画面でもにじまない */
const ZOOM = 2;

const UPLOAD_URL = "https://upload.gyazo.com/api/upload";

export type ReadmeImage = {
  /** README のマーカーの名前 */
  readonly name: string;
  /** Worker のパス。**決定論的に描かれるもの**に限る (デモの図と説明図) */
  readonly path: string;
  readonly alt: string;
  /** 以下はスクリプトが書く。表示幅 (余白込み・等倍) */
  readonly width?: number;
  /** 撮ったときの SVG 本文の SHA-256 (16 進) */
  readonly sha256?: string;
  readonly url?: string;
};

export type Ledger = { readonly images: readonly ReadmeImage[] };

const MARKER = /^<!-- readme-image: ([a-z0-9-]+) -->$/;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function imgTag(image: ReadmeImage): string {
  if (image.url === undefined || image.width === undefined) {
    throw new Error(`${image.name} はまだ撮っていない (npm run readme-images)`);
  }
  const alt = image.alt.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return `<img src="${image.url}" width="${image.width}" alt="${alt}">`;
}

/**
 * README のマーカーの次の行を、台帳の `<img>` に置き換える。次の行が `<img` でなければ挿す。
 * **台帳とマーカーは 1 対 1** — 片方にしか無い名前があれば投げる (貼り忘れ・消し忘れ)。
 */
export function applyImages(readme: string, images: readonly ReadmeImage[]): string {
  const byName = new Map(images.map((image) => [image.name, image]));
  const seen = new Set<string>();
  const lines = readme.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    out.push(line);
    const name = MARKER.exec(line)?.[1];
    if (name === undefined) {
      continue;
    }
    const image = byName.get(name);
    if (image === undefined) {
      throw new Error(`README のマーカー ${name} が台帳 (${LEDGER_PATH}) に無い`);
    }
    if (seen.has(name)) {
      throw new Error(`README にマーカー ${name} が 2 つある`);
    }
    seen.add(name);
    out.push(imgTag(image));
    if (lines[i + 1]?.startsWith("<img ")) {
      i++;
    }
  }
  const missing = images.filter((image) => !seen.has(image.name)).map((image) => image.name);
  if (missing.length > 0) {
    throw new Error(`台帳の ${missing.join(", ")} のマーカーが README に無い`);
  }
  return out.join("\n");
}

/** SVG を白地と余白の付いた SVG で包む。戻り値の幅と高さは余白込み */
export function framed(svg: string): { svg: string; width: number; height: number } {
  const width = Number(/<svg[^>]*\swidth="(\d+(?:\.\d+)?)"/.exec(svg)?.[1]);
  const height = Number(/<svg[^>]*\sheight="(\d+(?:\.\d+)?)"/.exec(svg)?.[1]);
  if (!(width > 0 && height > 0)) {
    throw new Error("SVG のルートに width / height が無い");
  }
  const w = width + PADDING * 2;
  const h = height + PADDING * 2;
  const inner = svg.replace(/^<svg\s/, `<svg x="${PADDING}" y="${PADDING}" `);
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#ffffff"/>${inner}</svg>`,
    width: w,
    height: h,
  };
}

function rasterize(svg: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("rsvg-convert", ["--zoom", String(ZOOM), "--format", "png"]);
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "ENOENT" ? new Error("rsvg-convert が無い (brew install librsvg)") : error,
      ),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`rsvg-convert が失敗した: ${stderr}`)),
    );
    child.stdin.end(svg);
  });
}

async function gyazoToken(): Promise<string> {
  const fromEnv = process.env.GYAZO_ACCESS_TOKEN;
  if (fromEnv) {
    return fromEnv;
  }
  const { stdout } = await execFile("secret-read", ["gyazo-token"]);
  return stdout.trim();
}

async function upload(png: Buffer, title: string, token: string): Promise<string> {
  const form = new FormData();
  form.set("access_token", token);
  form.set("imagedata", new Blob([new Uint8Array(png)], { type: "image/png" }), "image.png");
  form.set("title", title);
  const res = await fetch(UPLOAD_URL, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`Gyazo へのアップロードが失敗した: ${res.status} ${await res.text()}`);
  }
  const { url } = (await res.json()) as { url?: string };
  if (typeof url !== "string") {
    throw new Error("Gyazo の応答に url が無い");
  }
  return url;
}

async function fetchSvg(origin: string, path: string): Promise<string> {
  const res = await fetch(`${origin}${path}`).catch((error: unknown) => {
    throw new Error(`${origin} に繋がらない。先に npm run dev を起動する (${String(error)})`);
  });
  if (!res.ok) {
    throw new Error(`${path} が ${res.status} を返した`);
  }
  return res.text();
}

async function main(): Promise<void> {
  if (process.env.CI) {
    throw new Error("CI では走らせない (Gyazo のトークンを Secrets に置かない)");
  }
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const origin = process.env.README_IMAGES_ORIGIN ?? DEFAULT_ORIGIN;

  const ledger = JSON.parse(await readFile(LEDGER_PATH, "utf8")) as Ledger;
  let token: string | undefined;
  const images = [...ledger.images];
  for (const [i, image] of images.entries()) {
    const svg = await fetchSvg(origin, image.path);
    const sha256 = sha256Hex(svg);
    if (!force && image.sha256 === sha256 && image.url !== undefined) {
      console.log(`${image.name}: 変わっていない`);
      continue;
    }
    const frame = framed(svg);
    const png = await rasterize(frame.svg);
    token ??= await gyazoToken();
    const url = await upload(png, `cosense-grass README: ${image.alt}`, token);
    console.log(`${image.name}: ${url}`);
    images[i] = { ...image, width: frame.width, sha256, url };
    // 1 枚ごとに書く。途中で止まっても、上げた分をもう一度上げずに済む
    await writeFile(LEDGER_PATH, `${JSON.stringify({ images }, null, 2)}\n`);
  }

  const readme = await readFile(README_PATH, "utf8");
  await writeFile(README_PATH, applyImages(readme, images));
}

// CLI として起動したときだけ走らせる (テストから import しても何もしない)
if (process.argv[1]?.endsWith("readme-images.ts")) {
  main().catch((error: unknown) => {
    console.error(`NG: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
