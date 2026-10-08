// 配布バンドルの先頭行に刻む「指紋」。配布ページを見た人が、どのコードが貼られているかを見分けるため。
//
//   // cosense-grass build 3f9a1c07b2d4 — commit 6f1103c (2026-10-08)
//
// 配布ページは「`dev-next` に貼って `dev` へ改名」「`dev` を `v1` へ改名」で運用するので、ページ名と中身の
// 対応は改名のたびに動く。**目印はコードそのものに入れて、改名と一緒に動かす** (ページ外のメモや手元の記録は付いてこない)。
//
// - **`build`** は指紋の行を除いた本体の SHA-256 の先頭 12 桁。**同じコードなら commit が違っても同じ**なので、
//   dev と v1 が同じかはこれだけを見比べればよい
// - **`commit`** はビルドした `HEAD` とその commit 日。コードが同じでも main が進めば変わるので、
//   **同じかどうかの判定には使わない** (`check-distribution.sh` も指紋の行を除いて比べる)。どの頃の main かを辿る手がかり
//
// 本体は「指紋の行を除き、末尾の改行 1 つを落としたもの」。Cosense は行の配列で持つので配信物に末尾の改行が無く、
// 手元のバンドルと配信物のどちらから計算しても同じ値になるようにする。
import { createHash } from "node:crypto";

export const FINGERPRINT_PREFIX = "// cosense-grass build ";

/** `build` の桁数。目で見比べられる短さで、偶然の一致は起きない長さ */
const BUILD_DIGITS = 12;

const FINGERPRINT_LINE =
  /^\/\/ cosense-grass build ([0-9a-f]{12}) — commit ([0-9a-f]{7,40}(?:\+dirty)?) \((\d{4}-\d{2}-\d{2})\)$/;

export type Source = {
  /** ビルドした `HEAD` の短い SHA。追跡しているファイルに変更があれば `+dirty` を付ける */
  readonly commit: string;
  /** commit 日 (`YYYY-MM-DD`)。ビルドした日ではなく commit の日なので、同じ commit からは同じ行になる */
  readonly date: string;
};

export type Fingerprint = Source & { readonly build: string };

/** 指紋の行を除き、末尾の改行 1 つを落とした本体 */
export function bodyOf(text: string): string {
  const withoutLine = text.startsWith(FINGERPRINT_PREFIX)
    ? text.slice(text.indexOf("\n") + 1)
    : text;
  return withoutLine.endsWith("\n") ? withoutLine.slice(0, -1) : withoutLine;
}

export function buildId(text: string): string {
  return createHash("sha256").update(bodyOf(text)).digest("hex").slice(0, BUILD_DIGITS);
}

function formatFingerprint({ build, commit, date }: Fingerprint): string {
  return `${FINGERPRINT_PREFIX}${build} — commit ${commit} (${date})`;
}

/** esbuild の出力の先頭に指紋の行を足す。既に指紋があれば付け替える */
export function stamp(bundle: string, source: Source): string {
  const rest = bundle.startsWith(FINGERPRINT_PREFIX)
    ? bundle.slice(bundle.indexOf("\n") + 1)
    : bundle;
  return `${formatFingerprint({ ...source, build: buildId(rest) })}\n${rest}`;
}

/** 先頭行の指紋を読む。無いか形が違えば `undefined` */
export function parseFingerprint(text: string): Fingerprint | undefined {
  const first = text.split("\n", 1)[0] ?? "";
  const match = FINGERPRINT_LINE.exec(first);
  if (match === null) {
    return undefined;
  }
  const [, build = "", commit = "", date = ""] = match;
  return { build, commit, date };
}
