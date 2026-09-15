// 配布ページ (Cosense の公開プロジェクト /cosense-grass) の `code:script.js` を、
// 手元のバンドルで全面差し替えする (ADR-0013 決定 3 の 2026-09-15 の改訂、Issue #105)。
//
//   node scripts/paste-distribution.ts <page> [bundle]
//   npm run paste -- dev
//
// **CI では走らせない。** 認証は手元の `cosense` CLI が持つ Personal Access Token で、
// PAT はスコープを持たない (そのユーザーが見られる範囲すべて)。GitHub の Secrets には置かない。
//
// ## 順番を間違えると配布ページが空になる
//
// ops は 1 リクエスト 30KB 前後にしか載らない (research §4) ので、全面差し替えは複数の commit に割れる。
// **先に新しい行を挿入し、後で古い行を消す** — 逆順だと、途中で配布ページが空になり、
// その間 import している人に壊れたスクリプトが配られる。
//
// **消す行は挿入より前に決める。** 2026-09-15 に、挿入した後でページを読み直して
// 「コード行を全部消す」としたために、入れたばかりの新しい行まで消して dev を 40 秒空にした (#105)。
// `pasteBundle` はページのスナップショットを 1 回だけ受け取り、**中で読み直さない**ことで、
// この間違いを構造的に起こせなくしている。
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const PROJECT_URL = "https://scrapbox.io/cosense-grass";

/** 1 リクエストに載せる ops のおよそのバイト数。31KB は通り、それ以上は未確認 (research §4) */
const CHUNK_BYTES = 25_000;

/** 1 リクエストに入れる delete の数。1 件およそ 40 バイト */
const DELETES_PER_REQUEST = 600;

/** `503 Service Unavailable` が混ざる。preview からやり直す (previewId は 1 回限り) */
const ATTEMPTS = 3;
const RETRY_WAIT_MS = 3_000;

/** コード記法の中身は 1 段のインデント。空行は " " になる */
const INDENT = " ";

export type Line = { readonly id: string; readonly text: string };

export type Page = { readonly id: string; readonly lines: readonly Line[] };

export type Op =
  | { readonly insertBefore: string; readonly text: string }
  | { readonly delete: string };

export type Plan = {
  /** 挿入の宛先。コード記法がページ末尾まで続くなら `_end` */
  readonly anchor: string;
  /** 挿入。配列順に適用する */
  readonly insertOps: readonly (readonly Op[])[];
  /** 削除。**挿入より前のページから決める** */
  readonly deleteOps: readonly (readonly Op[])[];
  readonly newLines: number;
  readonly oldLines: number;
};

/** バイト数で割る (`insertBefore` の text は改行で複数行になるので、行数ではなくバイト数で割る) */
export function chunkByBytes(lines: readonly string[], limit: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    const bytes = Buffer.byteLength(line) + 1;
    if (current.length > 0 && size + bytes > limit) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += bytes;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** コード記法の中身とみなす行 (1 段インデントされている) */
function inCodeBlock(text: string): boolean {
  return text.startsWith(INDENT);
}

/**
 * 差し替えの手順を決める。**ページのスナップショットからだけ決める**ので、
 * ここで返した `deleteOps` は挿入の影響を受けない。
 *
 * `deleteIds` を渡すとそれを消す。**途中から再開するときは必ず渡す** —
 * 再開時のページには挿入済みの新しい行が混ざっており、そこから決め直すと入れたばかりの行まで消す (#105)。
 */
export function planPaste(page: Page, bundleText: string, deleteIds?: readonly string[]): Plan {
  const lines = page.lines;
  if (lines.length < 2 || lines[1]?.text !== "code:script.js") {
    throw new Error(`2 行目が code:script.js でない: ${JSON.stringify(lines[1]?.text)}`);
  }
  const body = lines.slice(2);
  // コード記法の外に何か書いてあれば、その手前に挿し込む (末尾に足すとコード記法から外れる)
  const after = body.findIndex((line) => !inCodeBlock(line.text));
  const code = after === -1 ? body : body.slice(0, after);
  const anchor = after === -1 ? "_end" : (body[after]?.id ?? "_end");
  const victims = deleteIds ?? code.map((line) => line.id);

  const source = bundleText.split("\n");
  if (source.at(-1) === "") {
    source.pop();
  }
  const indented = source.map((line) => INDENT + line);

  return {
    anchor,
    insertOps: chunkByBytes(indented, CHUNK_BYTES).map((part) => [
      { insertBefore: anchor, text: part.join("\n") },
    ]),
    // **ここが要。** 消すのは、挿入より前に決めた行だけ
    deleteOps: chunk(victims, DELETES_PER_REQUEST).map((ids) => ids.map((id) => ({ delete: id }))),
    newLines: indented.length,
    oldLines: victims.length,
  };
}

export type PasteDependencies = {
  /** ops をページに適用する (preview → submit)。**失敗したら投げる** */
  readonly apply: (ops: readonly Op[], label: string) => Promise<void>;
  readonly log: (message: string) => void;
  /**
   * 途中まで進んだことを覚える。再実行で同じ挿入を繰り返さないため。
   * **消す行の一覧も一緒に渡す** — 再開時のページからは決め直せない (#105)
   */
  readonly remember?: (done: {
    readonly inserts: number;
    readonly deletes: number;
    readonly deleteIds: readonly string[];
  }) => Promise<void>;
  /** 前回どこまで進んだか。`deleteIds` は最初に決めたもの */
  readonly resume?: {
    readonly inserts: number;
    readonly deletes: number;
    readonly deleteIds: readonly string[];
  };
};

/**
 * 差し替えを実行する。**ページを読み直さない** — 受け取ったスナップショットから決めた手順だけを流す。
 */
export async function pasteBundle(
  page: Page,
  bundleText: string,
  deps: PasteDependencies,
): Promise<Plan> {
  // **再開なら、消す行は前回決めたものを使う。** 今のページから決め直すと、挿入済みの行まで消す (#105)
  const plan = planPaste(page, bundleText, deps.resume?.deleteIds);
  const done = deps.resume ?? { inserts: 0, deletes: 0 };
  const deleteIds = plan.deleteOps.flatMap((ops) =>
    ops.map((op) => ("delete" in op ? op.delete : "")),
  );
  deps.log(
    `${plan.oldLines} 行を ${plan.newLines} 行に差し替える (挿入 ${plan.insertOps.length} 回 → 削除 ${plan.deleteOps.length} 回)`,
  );

  for (const [i, ops] of plan.insertOps.entries()) {
    if (i < done.inserts) {
      deps.log(`  挿入 ${i + 1}/${plan.insertOps.length}: 済み`);
      continue;
    }
    await deps.apply(ops, `挿入 ${i + 1}/${plan.insertOps.length}`);
    await deps.remember?.({ inserts: i + 1, deletes: 0, deleteIds });
  }
  for (const [i, ops] of plan.deleteOps.entries()) {
    if (i < done.deletes) {
      deps.log(`  削除 ${i + 1}/${plan.deleteOps.length}: 済み`);
      continue;
    }
    await deps.apply(ops, `削除 ${i + 1}/${plan.deleteOps.length}`);
    await deps.remember?.({ inserts: plan.insertOps.length, deletes: i + 1, deleteIds });
  }
  return plan;
}

// ---- ここから下は CLI (ネットワークとファイルを触る) ----

async function cosense(args: readonly string[], stdin?: string): Promise<string> {
  const child = execFile("cosense", [...args], { maxBuffer: 64 * 1024 * 1024 });
  if (stdin !== undefined) {
    child.child.stdin?.end(stdin);
  }
  const { stdout } = await child;
  return stdout;
}

function field(output: string, name: string): string | undefined {
  return output
    .split("\n")
    .find((line) => line.startsWith(`${name}:`))
    ?.slice(name.length + 1)
    .trim();
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeApply(pageId: string, log: (message: string) => void) {
  return async (ops: readonly Op[], label: string) => {
    const payload = JSON.stringify({ ops });
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const preview = await cosense(["previewEdit", PROJECT_URL, pageId], payload);
        const previewId = field(preview, "previewId");
        if (previewId === undefined) {
          throw new Error(`previewId を読めなかった: ${preview.slice(0, 200)}`);
        }
        const submitted = await cosense(["submitEdit", PROJECT_URL, previewId]);
        log(`  ${label}: ok (${payload.length} バイト, commit ${field(submitted, "commitId")})`);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === ATTEMPTS) {
          throw new Error(`${label}: ${ATTEMPTS} 回試して通らなかった — ${message.slice(0, 300)}`);
        }
        log(`  ${label}: ${attempt}/${ATTEMPTS} 回目が失敗 (${message.slice(0, 120)})`);
        await wait(RETRY_WAIT_MS);
      }
    }
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

type State = {
  readonly page: string;
  readonly pageId: string;
  readonly bundleSha: string;
  readonly inserts: number;
  readonly deletes: number;
  /** **最初に決めた消す行。** 再開時のページからは決め直せない (#105) */
  readonly deleteIds: readonly string[];
};

async function readState(path: string): Promise<State | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as State;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  if (process.env.CI) {
    throw new Error("CI では走らせない (PAT を Secrets に置かない。ADR-0013 決定 3)");
  }
  const [page, bundlePath = "dist/userscript.js"] = process.argv.slice(2);
  if (page === undefined) {
    throw new Error("ページ名を渡す (例: npm run paste -- dev)");
  }

  const bundleText = await readFile(bundlePath, "utf8");
  const statePath = `dist/paste-${page}.state.json`;
  const log = (message: string) => console.log(message);

  // 貼る前に配信物と比べる。**既に一致していれば何もしない** (同じ中身で commit を増やさない)
  const check = await execFile("./scripts/check-distribution.sh", [page, bundlePath]).catch(
    (error: { code?: number; stdout?: string; stderr?: string }) => error,
  );
  if ("code" in check && check.code === 2) {
    throw new Error(`配信物を取得できなかった: ${check.stderr ?? ""}`);
  }
  if (!("code" in check)) {
    log(`配布ページ ${page} は既に手元のバンドルと一致している。何もしない`);
    return;
  }

  const raw = await cosense(["readPage", `${PROJECT_URL}/${page}`]);
  const fetched = JSON.parse(raw) as Page & { persistent?: boolean };
  if (fetched.persistent === false) {
    throw new Error(`ページ ${page} がまだ無い。Cosense で code:script.js だけ作ってから貼る`);
  }

  const previous = await readState(statePath);
  const bundleSha = sha256(bundleText);
  let resume: State | undefined;
  if (previous?.pageId === fetched.id && previous.page === page) {
    if (previous.bundleSha !== bundleSha) {
      throw new Error(
        `前回の途中経過 (${statePath}) が別のバンドルのもの。` +
          "配布ページに中途半端な行が残っているので、Cosense で確かめてから消す",
      );
    }
    if (!Array.isArray(previous.deleteIds)) {
      throw new Error(`前回の途中経過 (${statePath}) に消す行の一覧が無い。手で消してからやり直す`);
    }
    resume = previous;
    log(
      `前回の続きから (挿入 ${previous.inserts} / 削除 ${previous.deletes} まで済み、消す行 ${previous.deleteIds.length})`,
    );
  }

  const remember = async (done: {
    inserts: number;
    deletes: number;
    deleteIds: readonly string[];
  }) => {
    const state: State = { page, pageId: fetched.id, bundleSha, ...done };
    await writeFile(statePath, JSON.stringify(state));
  };

  log(`${page}: ${fetched.lines.length} 行 / バンドル ${bundleText.length} バイト`);
  await pasteBundle(fetched, bundleText, {
    apply: makeApply(fetched.id, log),
    log,
    remember,
    ...(resume
      ? {
          resume: {
            inserts: resume.inserts,
            deletes: resume.deletes,
            deleteIds: resume.deleteIds,
          },
        }
      : {}),
  });
  await rm(statePath, { force: true });

  // 配信物と手元のバンドルを SHA-256 で突き合わせる (末尾の改行だけは Cosense 側に無い)
  const { stdout } = await execFile("./scripts/check-distribution.sh", [page, bundlePath]);
  log(stdout.trim());
}

// CLI として起動したときだけ走らせる (テストから import しても何もしない)
if (process.argv[1]?.endsWith("paste-distribution.ts")) {
  main().catch((error: unknown) => {
    console.error(`NG: ${error instanceof Error ? error.message : String(error)}`);
    console.error(
      "途中で止まったときは、同じコマンドをもう一度走らせると続きから再開する " +
        "(dist/paste-<page>.state.json に進み具合が残っている)",
    );
    process.exitCode = 1;
  });
}
