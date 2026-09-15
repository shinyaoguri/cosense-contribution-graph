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
import { build } from "esbuild";

const repository = "https://github.com/shinyaoguri/cosense-contribution-graph";

const result = await build({
  entryPoints: ["src/userscript/index.ts"],
  outfile: "dist/userscript.js",
  bundle: true,
  format: "iife",
  target: "es2023",
  platform: "browser",
  charset: "utf8",
  legalComments: "none",
  minify: false,
  sourcemap: false,
  metafile: true,
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

const outputs = Object.entries(result.metafile.outputs);
if (outputs.length === 0) {
  throw new Error("esbuild が出力を返さなかった");
}
for (const [outfile, info] of outputs) {
  console.log(`${outfile} (${info.bytes} バイト)`);
}
