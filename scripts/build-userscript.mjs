// UserScript の配布バンドルを作る。
//
// Cosense のユーザーページから `import "/api/code/<project>/<page>/script.js"` の 1 行で
// 読み込まれる (ADR-0005)。外部ドメインからの import は Cosense の UserScript の
// 仕組み上成立しないので、配布は Cosense の公開プロジェクト経由になる。
//
// IIFE にするのは export を持たせる必要がないため。module として import されても
// そのまま実行される。
//
// **minify しない。** 他人のブラウザで動くコードなので、読んで確かめられる形で配る。
// 大きくなってきたら段階 5 で再検討する。
//
// **先頭行に指紋 (中身の SHA-256 と commit) を刻む** (`bundle-fingerprint.ts`)。配布ページを見た人が、
// どのコードが貼られているか・dev と v1 が同じかを見分けるため。
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { build } from "esbuild";
import { parseFingerprint, stamp } from "./bundle-fingerprint.ts";

const outfile = "dist/userscript.js";

const repository = "https://github.com/shinyaoguri/cosense-contribution-graph";

const result = await build({
  entryPoints: ["src/userscript/index.ts"],
  outfile,
  bundle: true,
  format: "iife",
  target: "es2023",
  platform: "browser",
  charset: "utf8",
  legalComments: "none",
  minify: false,
  sourcemap: false,
  metafile: true,
  // 指紋は書き出した中身から計算するので、esbuild には書かせない
  write: false,
  banner: {
    js: `// cosense-contribution-graph — ${repository}\n// このファイルは生成物。編集は上のリポジトリで。`,
  },
});

// **Worker のコードをバンドルに入れない** (Issue #110)。esbuild の tree-shaking は
// トップレベルの関数呼び出し (`bandScheme({...})`) や二項演算 (`CELL + GAP`) を副作用ありと
// みなすので、未参照でも配られてしまう。落ちるかどうかに頼らず、入口で止める。
const workerInputs = Object.keys(result.metafile.inputs).filter((path) =>
  path.startsWith("src/worker/"),
);
if (workerInputs.length > 0) {
  throw new Error(
    `UserScript のバンドルに Worker のコードが入っている:\n  ${workerInputs.join("\n  ")}`,
  );
}

const output = result.outputFiles?.[0];
if (output === undefined) {
  throw new Error("esbuild が出力を返さなかった");
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
const bundle = stamp(output.text, {
  commit: `${git("rev-parse", "--short=7", "HEAD")}${dirty ? "+dirty" : ""}`,
  date: git("log", "-1", "--format=%cs"),
});
mkdirSync(dirname(outfile), { recursive: true });
writeFileSync(outfile, bundle);

const fingerprint = parseFingerprint(bundle);
console.log(
  `${outfile} (${Buffer.byteLength(bundle)} バイト) build ${fingerprint?.build} — commit ${fingerprint?.commit}`,
);
