import { describe, expect, it } from "vitest";
import {
  chunkByBytes,
  type Line,
  type Op,
  type Page,
  pasteBundle,
  planPaste,
} from "../../scripts/paste-distribution.ts";

/** 配布ページの形 (題 + コード記法 + 1 段インデントされたコード行) */
function page(code: readonly string[], trailing: readonly string[] = []): Page {
  const lines: Line[] = [
    { id: "L0", text: "dev" },
    { id: "L1", text: "code:script.js" },
    ...code.map((text, i) => ({ id: `C${i}`, text: ` ${text}` })),
    ...trailing.map((text, i) => ({ id: `T${i}`, text })),
  ];
  return { id: "PAGE", lines };
}

/**
 * ops を当てる偽のページ。**本物と同じく、当てるたびに行が増減する** ので、
 * 消す行を挿入の後に決める実装ならここで壊れる。
 */
function editable(initial: Page) {
  const lines = [...initial.lines];
  let next = 0;
  const applied: string[] = [];
  const apply = async (ops: readonly Op[], label: string) => {
    applied.push(label);
    for (const op of ops) {
      if ("delete" in op) {
        const at = lines.findIndex((line) => line.id === op.delete);
        if (at === -1) {
          throw new Error(`422: 消す行が無い ${op.delete}`);
        }
        lines.splice(at, 1);
        continue;
      }
      const added = op.text.split("\n").map((text) => ({ id: `N${next++}`, text }));
      if (op.insertBefore === "_end") {
        lines.push(...added);
        continue;
      }
      const at = lines.findIndex((line) => line.id === op.insertBefore);
      if (at === -1) {
        throw new Error(`422: anchor が無い ${op.insertBefore}`);
      }
      lines.splice(at, 0, ...added);
    }
  };
  return {
    apply,
    applied,
    lines: () => [...lines],
    texts: () => lines.map((line) => line.text),
  };
}

const silent = () => undefined;

const bundle = (lines: readonly string[]) => `${lines.join("\n")}\n`;

describe("planPaste", () => {
  it("**消す行はページのスナップショットから決める** (挿入の後に読み直さない。Issue #105)", () => {
    const plan = planPaste(page(["a", "b", "c"]), bundle(["x"]));

    expect(plan.deleteOps.flat()).toEqual([{ delete: "C0" }, { delete: "C1" }, { delete: "C2" }]);
    expect(plan.oldLines).toBe(3);
    expect(plan.newLines).toBe(1);
  });

  it("**コード記法がページ末尾まで続くなら `_end` に挿す**", () => {
    const plan = planPaste(page(["a"]), bundle(["x", "y"]));

    expect(plan.anchor).toBe("_end");
    expect(plan.insertOps.flat()).toEqual([{ insertBefore: "_end", text: " x\n y" }]);
  });

  it("**コード記法の外に何か書いてあれば、その手前に挿す** (末尾に足すとコード記法から外れる)", () => {
    const plan = planPaste(page(["a"], ["", "この下は関係ない"]), bundle(["x"]));

    expect(plan.anchor).toBe("T0");
    // 消すのはコード記法の中だけ
    expect(plan.deleteOps.flat()).toEqual([{ delete: "C0" }]);
  });

  it("空行は 1 スペースになる (コード記法から外れない)", () => {
    const plan = planPaste(page([]), bundle(["x", "", "y"]));

    expect(plan.insertOps.flat()).toEqual([{ insertBefore: "_end", text: " x\n \n y" }]);
  });

  it("コード記法が無いページは断る", () => {
    expect(() => planPaste({ id: "P", lines: [{ id: "L0", text: "dev" }] }, bundle(["x"]))).toThrow(
      /code:script\.js/,
    );
  });
});

describe("pasteBundle", () => {
  it("**先に挿し、後で消す。** 途中で行が増えても、消えるのは元のコード行だけ (Issue #105)", async () => {
    // 1 リクエストに載らない大きさにして、挿入も削除も複数回に割れるようにする
    const old = Array.from({ length: 1_500 }, (_, i) => `old ${i} ${"y".repeat(40)}`);
    const next = Array.from({ length: 1_200 }, (_, i) => `new ${i} ${"z".repeat(40)}`);
    const target = editable(page(old));

    const plan = await pasteBundle(page(old), bundle(next), {
      apply: target.apply,
      log: silent,
    });

    expect(plan.insertOps.length).toBeGreaterThan(1);
    expect(plan.deleteOps.length).toBeGreaterThan(1);
    // 挿入がすべて先、削除がすべて後
    expect(target.applied.map((label) => label.slice(0, 2))).toEqual([
      ...Array(plan.insertOps.length).fill("挿入"),
      ...Array(plan.deleteOps.length).fill("削除"),
    ]);
    expect(target.texts()).toEqual(["dev", "code:script.js", ...next.map((line) => ` ${line}`)]);
  });

  it("**途中で止まった続きは、消す行を決め直さずに流す** (再開時のページには挿入済みの行が混ざる。Issue #105)", async () => {
    const next = Array.from({ length: 1_200 }, (_, i) => `new ${i} ${"z".repeat(40)}`);
    const snapshot = page(["old a", "old b"]);
    const target = editable(snapshot);
    let state: { inserts: number; deletes: number; deleteIds: readonly string[] } | undefined;

    // 1 回目: 挿入の 2 回目で落ちる
    await expect(
      pasteBundle(snapshot, bundle(next), {
        apply: async (ops, label) => {
          if (label.startsWith("挿入 2")) {
            throw new Error("503");
          }
          await target.apply(ops, label);
        },
        log: silent,
        remember: async (done) => {
          state = done;
        },
      }),
    ).rejects.toThrow("503");
    expect(state).toMatchObject({ inserts: 1, deletes: 0, deleteIds: ["C0", "C1"] });

    // 2 回目: **ページを読み直してから**再開する (本物と同じ手順)。挿入済みの行が混ざっている
    const reread: Page = { id: snapshot.id, lines: target.lines() };
    expect(reread.lines.length).toBeGreaterThan(snapshot.lines.length);

    await pasteBundle(reread, bundle(next), {
      apply: target.apply,
      log: silent,
      ...(state ? { resume: state } : {}),
    });

    // 消えたのは元の 2 行だけ。挿入済みの行は残る
    expect(target.texts()).toEqual(["dev", "code:script.js", ...next.map((line) => ` ${line}`)]);
  });
});

describe("chunkByBytes", () => {
  it("**バイト数で割る** (行数ではない。日本語を含む行があるため)", () => {
    const chunks = chunkByBytes(["あいう", "えお", "x"], 10);

    // "あいう" は 9 バイト + 改行 1 で 10。次の行は入らない
    expect(chunks).toEqual([["あいう"], ["えお", "x"]]);
  });

  it("上限より長い 1 行は、単独の塊として通す (割れないので落とさない)", () => {
    expect(chunkByBytes(["x".repeat(50)], 10)).toEqual([["x".repeat(50)]]);
  });
});
