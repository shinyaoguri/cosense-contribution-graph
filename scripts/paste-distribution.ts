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
// `pasteBundle` は消す行をページのスナップショットからだけ決め、**読み直したページからは決めない**ことで、
// この間違いを構造的に起こせなくしている。
//
// ## 別名のコード記法に入れてから、見出しの付け替え 1 回で切り替える (#166)
//
// `code:script.js` は、ページ内の同名のコード記法を上から連結して配られる (research §2)。
// 同じ名前のまま「挿入 → 削除」すると、その間は新旧 2 本が並んだ壊れた JS が配られ、
// Cosense の 5xx で途中で止まるとそのまま残った (2026-09-26〜27 に 3 回)。そこで:
//
// 1. 挿入: 新しいバンドルを `code:script.next.js` として挿す。名前が違うので配られない
// 2. 切り替え: 古い見出しを `code:script.old.js`、新しい見出しを `code:script.js` にする。**1 commit**
// 3. 削除: 古い見出しとコード行を消す。残骸は `script.old.js` なので配られない
//
// **どこで止まっても、配られる `script.js` は旧か新のどちらか丸ごと**になる。
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

/**
 * 試し直しの待ち。preview はページが大きいほど遅く (3,000 行で 4〜25 秒。research §4)、貼っている途中の
 * 新旧 2 本ぶん (約 6,000 行) では `503 Service Unavailable` や HTML のエラーページが 1 分以上続く (#166・#180)。
 * 間隔を伸ばしながら 8 回試し直す (1 回の待ちは 60 秒まで、合計約 4 分)。どこで止まっても配信物は壊れないので
 * (#178)、長く待つことに害は無い。preview からやり直す (previewId は 1 回限り)
 */
export const RETRY_WAITS_MS: readonly number[] = [
  2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000,
];

/** 配信されるファイルの見出し */
export const SCRIPT_TITLE = "code:script.js";
/** 挿入中の新しいバンドルの見出し。**配られない名前** */
export const NEXT_TITLE = "code:script.next.js";
/** 切り替えた後の古いバンドルの見出し。消し終わるまでの残骸 */
export const OLD_TITLE = "code:script.old.js";

/** コード記法の中身は 1 段のインデント。空行は " " になる */
const INDENT = " ";

export type Line = { readonly id: string; readonly text: string };

export type Page = { readonly id: string; readonly lines: readonly Line[] };

export type Op =
  | { readonly insertBefore: string; readonly text: string }
  /** 1 行の本文を置き換える。**text は 1 行だけ** (research §4) */
  | { readonly replace: string; readonly text: string }
  | { readonly delete: string };

/** 途中まで進んだこと。**スナップショットから決めたものを持ち越す** — 再開時のページからは決め直せない (#105) */
export type Progress = {
  /** 挿入の宛先。再開時のページでは、挿入済みの見出しが邪魔をして決め直せない */
  readonly anchor: string;
  /** 古い見出し (`code:script.js`) の行 */
  readonly oldTitleId: string;
  /** 消す行 (古いコード行と、最後に古い見出し) */
  readonly deleteIds: readonly string[];
  readonly inserts: number;
  readonly swapped: boolean;
  readonly deletes: number;
};

export type Plan = {
  /** 挿入の宛先。コード記法がページ末尾まで続くなら `_end` */
  readonly anchor: string;
  readonly oldTitleId: string;
  /** 挿入。配列順に適用する。先頭の塊が `code:script.next.js` の見出しから始まる */
  readonly insertOps: readonly (readonly Op[])[];
  /** 削除。**挿入より前のページから決める** */
  readonly deleteOps: readonly (readonly Op[])[];
  readonly deleteIds: readonly string[];
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
 * `resume` を渡すと、宛先・古い見出し・消す行はそれを使い、ページは見ない。**途中から再開するときは必ず渡す** —
 * 再開時のページには挿入済みの新しい行が混ざっており、そこから決め直すと入れたばかりの行まで消す (#105)。
 */
export function planPaste(
  page: Page,
  bundleText: string,
  resume?: Pick<Progress, "anchor" | "oldTitleId" | "deleteIds">,
): Plan {
  let anchor: string;
  let oldTitleId: string;
  let deleteIds: readonly string[];
  if (resume === undefined) {
    const lines = page.lines;
    if (lines.length < 2 || lines[1]?.text !== SCRIPT_TITLE) {
      throw new Error(`2 行目が ${SCRIPT_TITLE} でない: ${JSON.stringify(lines[1]?.text)}`);
    }
    // 前に止まった残骸があると、切り替えで見出しを取り違える。人が確かめてから消す
    const leftover = lines.find((line) => line.text === NEXT_TITLE || line.text === OLD_TITLE);
    if (leftover !== undefined) {
      throw new Error(`前に止まった残骸 ${leftover.text} がある。Cosense で確かめて消してから貼る`);
    }
    const body = lines.slice(2);
    // コード記法の外に何か書いてあれば、その手前に挿し込む (末尾に足すとコード記法から外れる)
    const after = body.findIndex((line) => !inCodeBlock(line.text));
    const code = after === -1 ? body : body.slice(0, after);
    anchor = after === -1 ? "_end" : (body[after]?.id ?? "_end");
    oldTitleId = lines[1]?.id ?? "";
    // 古い見出しは最後に消す。途中で止まっても、残骸が `script.old.js` のまとまりとして読める
    deleteIds = [...code.map((line) => line.id), oldTitleId];
  } else {
    ({ anchor, oldTitleId, deleteIds } = resume);
  }

  const source = bundleText.split("\n");
  if (source.at(-1) === "") {
    source.pop();
  }
  const indented = source.map((line) => INDENT + line);

  return {
    anchor,
    oldTitleId,
    // 見出しごと挿す。見出しはインデントしないので、古いコード記法はその手前で閉じる
    insertOps: chunkByBytes([NEXT_TITLE, ...indented], CHUNK_BYTES).map((part) => [
      { insertBefore: anchor, text: part.join("\n") },
    ]),
    // **ここが要。** 消すのは、挿入より前に決めた行だけ
    deleteOps: chunk(deleteIds, DELETES_PER_REQUEST).map((ids) =>
      ids.map((id) => ({ delete: id })),
    ),
    deleteIds,
    newLines: indented.length,
    oldLines: deleteIds.length - 1,
  };
}

/**
 * 切り替えの ops。**挿入した後のページ**から新しい見出しを探す (行 ID は挿入の後でしか分からない)。
 * 消す行はここで決めない (#105)。
 *
 * 切り替えが届いたのに応答だけ失敗したときに備え、既に切り替わっていれば `undefined` を返す。
 */
export function planSwap(page: Page, oldTitleId: string): readonly Op[] | undefined {
  const nexts = page.lines.filter((line) => line.text === NEXT_TITLE);
  const oldTitle = page.lines.find((line) => line.id === oldTitleId);
  if (nexts.length === 0 && oldTitle?.text === OLD_TITLE) {
    return undefined;
  }
  const next = nexts[0];
  if (nexts.length !== 1 || next === undefined) {
    throw new Error(`${NEXT_TITLE} の見出しが ${nexts.length} 個ある (1 個のはず)`);
  }
  if (oldTitle?.text !== SCRIPT_TITLE) {
    throw new Error(`古い見出しが ${SCRIPT_TITLE} でない: ${JSON.stringify(oldTitle?.text)}`);
  }
  return [
    { replace: oldTitleId, text: OLD_TITLE },
    { replace: next.id, text: SCRIPT_TITLE },
  ];
}

export type PasteDependencies = {
  /** ops をページに適用する (preview → submit)。**失敗したら投げる** */
  readonly apply: (ops: readonly Op[], label: string) => Promise<void>;
  /** 切り替えの直前に、新しい見出しの行 ID を知るために 1 回だけ読む */
  readonly readPage: () => Promise<Page>;
  readonly log: (message: string) => void;
  /**
   * 途中まで進んだことを覚える。再実行で同じ挿入を繰り返さないため。
   * **消す行の一覧も一緒に渡す** — 再開時のページからは決め直せない (#105)
   */
  readonly remember?: (done: Progress) => Promise<void>;
  /** 前回どこまで進んだか。宛先・古い見出し・消す行は最初に決めたもの */
  readonly resume?: Progress;
};

/** 止まったときに、配られている `script.js` がどうなっているかを添える */
function stoppedAt(phase: "insert" | "swap" | "delete", error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const state = {
    insert: "script.js は古いまま動いている (切り替え前)",
    swap: "script.js は古いか新しいかのどちらか丸ごとで、壊れてはいない (もう一度走らせると確かめて進む)",
    delete: "script.js は新しいものに切り替え済み。script.old.js の残骸が残っている",
  }[phase];
  return new Error(`${message}\n${state}`);
}

/**
 * 差し替えを実行する。**ページを読み直さない** — 受け取ったスナップショットから決めた手順だけを流す。
 */
export async function pasteBundle(
  page: Page,
  bundleText: string,
  deps: PasteDependencies,
): Promise<Plan> {
  // **再開なら、宛先と消す行は前回決めたものを使う。** 今のページから決め直すと、挿入済みの行まで消す (#105)
  const plan = planPaste(page, bundleText, deps.resume);
  let progress: Progress = deps.resume ?? {
    anchor: plan.anchor,
    oldTitleId: plan.oldTitleId,
    deleteIds: plan.deleteIds,
    inserts: 0,
    swapped: false,
    deletes: 0,
  };
  const step = async (next: Partial<Progress>) => {
    progress = { ...progress, ...next };
    await deps.remember?.(progress);
  };
  deps.log(
    `${plan.oldLines} 行を ${plan.newLines} 行に差し替える (挿入 ${plan.insertOps.length} 回 → 切り替え → 削除 ${plan.deleteOps.length} 回)`,
  );

  try {
    for (const [i, ops] of plan.insertOps.entries()) {
      if (i < progress.inserts) {
        deps.log(`  挿入 ${i + 1}/${plan.insertOps.length}: 済み`);
        continue;
      }
      await deps.apply(ops, `挿入 ${i + 1}/${plan.insertOps.length}`);
      await step({ inserts: i + 1 });
    }
  } catch (error) {
    throw stoppedAt("insert", error);
  }

  if (progress.swapped) {
    deps.log("  切り替え: 済み");
  } else {
    try {
      const ops = planSwap(await deps.readPage(), plan.oldTitleId);
      if (ops === undefined) {
        deps.log("  切り替え: 前回の実行で済んでいた");
      } else {
        await deps.apply(ops, "切り替え");
      }
      await step({ swapped: true });
    } catch (error) {
      throw stoppedAt("swap", error);
    }
  }

  try {
    for (const [i, ops] of plan.deleteOps.entries()) {
      if (i < progress.deletes) {
        deps.log(`  削除 ${i + 1}/${plan.deleteOps.length}: 済み`);
        continue;
      }
      await deps.apply(ops, `削除 ${i + 1}/${plan.deleteOps.length}`);
      await step({ deletes: i + 1 });
    }
  } catch (error) {
    throw stoppedAt("delete", error);
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

/**
 * 試し直せば通りうる失敗か。**直らない失敗 (400 / 401 / 403 / 404 / 422) はすぐ止める** —
 * 待っても通らず、1 分待たせるだけになる。それ以外 (5xx・HTML のエラーページ・通信の失敗) は試し直す。
 * 409 `NotFastForward` は preview から作り直せば通るので試し直す側
 */
export function isRetryable(message: string): boolean {
  return !/\bHTTP (400|401|403|404|422)\b/.test(message);
}

/** 間隔を伸ばしながら試し直す (#166)。試し直さない失敗と、試し尽くした失敗は投げる */
export async function withRetries(
  task: () => Promise<void>,
  label: string,
  deps: {
    readonly log: (message: string) => void;
    readonly wait: (ms: number) => Promise<unknown>;
    readonly waits?: readonly number[];
  },
): Promise<void> {
  const waits = deps.waits ?? RETRY_WAITS_MS;
  const attempts = waits.length + 1;
  for (let attempt = 1; ; attempt++) {
    try {
      await task();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isRetryable(message)) {
        throw new Error(`${label}: 試し直しても通らない失敗 — ${message.slice(0, 300)}`);
      }
      const delay = waits[attempt - 1];
      if (delay === undefined) {
        throw new Error(`${label}: ${attempts} 回試して通らなかった — ${message.slice(0, 300)}`);
      }
      deps.log(
        `  ${label}: ${attempt}/${attempts} 回目が失敗、${delay / 1000} 秒後に試し直す (${message.slice(0, 120)})`,
      );
      await deps.wait(delay);
    }
  }
}

function makeApply(pageId: string, log: (message: string) => void) {
  return async (ops: readonly Op[], label: string) => {
    const payload = JSON.stringify({ ops });
    await withRetries(
      async () => {
        const preview = await cosense(["previewEdit", PROJECT_URL, pageId], payload);
        const previewId = field(preview, "previewId");
        if (previewId === undefined) {
          throw new Error(`previewId を読めなかった: ${preview.slice(0, 200)}`);
        }
        const submitted = await cosense(["submitEdit", PROJECT_URL, previewId]);
        log(`  ${label}: ok (${payload.length} バイト, commit ${field(submitted, "commitId")})`);
      },
      label,
      { log, wait },
    );
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

type State = Progress & {
  readonly page: string;
  readonly pageId: string;
  readonly bundleSha: string;
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
  const previous = await readState(statePath);

  // 貼る前に配信物と比べる。**既に一致していれば何もしない** (同じ中身で commit を増やさない)。
  // ただし途中経過があれば続ける — 切り替えた後に止まると、配信物は一致しても古い行が残っている
  const check = await execFile("./scripts/check-distribution.sh", [page, bundlePath]).catch(
    (error: { code?: number; stdout?: string; stderr?: string }) => error,
  );
  if ("code" in check && check.code === 2) {
    throw new Error(`配信物を取得できなかった: ${check.stderr ?? ""}`);
  }
  if (!("code" in check) && previous?.page !== page) {
    log(`配布ページ ${page} は既に手元のバンドルと一致している。何もしない`);
    return;
  }

  const readPage = async () =>
    JSON.parse(await cosense(["readPage", `${PROJECT_URL}/${page}`])) as Page & {
      persistent?: boolean;
    };
  const fetched = await readPage();
  if (fetched.persistent === false) {
    throw new Error(`ページ ${page} がまだ無い。Cosense で code:script.js だけ作ってから貼る`);
  }

  const bundleSha = sha256(bundleText);
  let resume: State | undefined;
  if (previous?.pageId === fetched.id && previous.page === page) {
    if (previous.bundleSha !== bundleSha) {
      throw new Error(
        `前回の途中経過 (${statePath}) が別のバンドルのもの。` +
          "配布ページに中途半端な行が残っているので、Cosense で確かめてから消す",
      );
    }
    // #166 より前の形 (宛先と古い見出しを持たない) からは続けられない
    if (
      !Array.isArray(previous.deleteIds) ||
      typeof previous.anchor !== "string" ||
      typeof previous.oldTitleId !== "string"
    ) {
      throw new Error(
        `前回の途中経過 (${statePath}) の形が古い。Cosense で確かめて手で直してからやり直す`,
      );
    }
    resume = previous;
    log(
      `前回の続きから (挿入 ${previous.inserts}・切り替え ${previous.swapped ? "済み" : "まだ"}・削除 ${previous.deletes} まで、消す行 ${previous.deleteIds.length})`,
    );
  }

  const remember = async (done: Progress) => {
    const state: State = { page, pageId: fetched.id, bundleSha, ...done };
    await writeFile(statePath, JSON.stringify(state));
  };

  log(`${page}: ${fetched.lines.length} 行 / バンドル ${bundleText.length} バイト`);
  await pasteBundle(fetched, bundleText, {
    apply: makeApply(fetched.id, log),
    readPage,
    log,
    remember,
    ...(resume
      ? {
          resume: {
            anchor: resume.anchor,
            oldTitleId: resume.oldTitleId,
            deleteIds: resume.deleteIds,
            inserts: resume.inserts,
            swapped: resume.swapped === true,
            deletes: resume.deletes,
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
