import { describe, expect, it } from "vitest";
import {
  chunkByBytes,
  isRetryable,
  type Line,
  NEXT_TITLE,
  OLD_TITLE,
  type Op,
  type Page,
  type Progress,
  pasteBundle,
  planPaste,
  planSwap,
  RETRY_WAITS_MS,
  SCRIPT_TITLE,
  withRetries,
} from "../../scripts/paste-distribution.ts";

/** 配布ページの形 (題 + コード記法 + 1 段インデントされたコード行) */
function page(code: readonly string[], trailing: readonly string[] = []): Page {
  const lines: Line[] = [
    { id: "L0", text: "dev" },
    { id: "L1", text: SCRIPT_TITLE },
    ...code.map((text, i) => ({ id: `C${i}`, text: ` ${text}` })),
    ...trailing.map((text, i) => ({ id: `T${i}`, text })),
  ];
  return { id: "PAGE", lines };
}

/**
 * Cosense が `/api/code/.../script.js` で配るもの。**同名のコード記法を上から連結する** (research §2)。
 * コード記法は `code:NAME` の行から、1 段インデントされた行が続くあいだ
 */
function served(lines: readonly Line[], name = "script.js"): string {
  const out: string[] = [];
  let current: string | undefined;
  for (const { text } of lines) {
    const title = /^code:(.+)$/.exec(text);
    if (title) {
      current = title[1];
      continue;
    }
    if (current !== undefined && text.startsWith(" ")) {
      if (current === name) {
        out.push(text.slice(1));
      }
      continue;
    }
    current = undefined;
  }
  return out.join("\n");
}

/**
 * ops を当てる偽のページ。**本物と同じく、当てるたびに行が増減する** ので、
 * 消す行を挿入の後に決める実装ならここで壊れる。`replace` は 1 行だけを受け付ける。
 */
function editable(initial: Page) {
  const lines = [...initial.lines];
  let next = 0;
  const applied: string[] = [];
  /** ops を 1 回当てた直後の配信物 */
  const snapshots: string[] = [];
  const find = (id: string) => {
    const at = lines.findIndex((line) => line.id === id);
    if (at === -1) {
      throw new Error(`HTTP 422: 行が無い ${id}`);
    }
    return at;
  };
  const apply = async (ops: readonly Op[], label: string) => {
    applied.push(label);
    for (const op of ops) {
      if ("delete" in op) {
        lines.splice(find(op.delete), 1);
        continue;
      }
      if ("replace" in op) {
        if (op.text.includes("\n")) {
          throw new Error("HTTP 422: replace に複数行");
        }
        lines[find(op.replace)] = { id: op.replace, text: op.text };
        continue;
      }
      const added = op.text.split("\n").map((text) => ({ id: `N${next++}`, text }));
      lines.splice(op.insertBefore === "_end" ? lines.length : find(op.insertBefore), 0, ...added);
    }
    snapshots.push(served(lines));
  };
  return {
    apply,
    applied,
    snapshots,
    readPage: async (): Promise<Page> => ({ id: initial.id, lines: [...lines] }),
    lines: () => [...lines],
    texts: () => lines.map((line) => line.text),
  };
}

const silent = () => undefined;

const bundle = (lines: readonly string[]) => `${lines.join("\n")}\n`;

// 1 リクエストに載らない大きさにして、挿入も削除も複数回に割れるようにする
const OLD = Array.from({ length: 1_500 }, (_, i) => `old ${i} ${"y".repeat(40)}`);
const NEW = Array.from({ length: 1_200 }, (_, i) => `new ${i} ${"z".repeat(40)}`);
const FINAL = ["dev", SCRIPT_TITLE, ...NEW.map((line) => ` ${line}`)];
const INSERTS = planPaste(page(OLD), bundle(NEW)).insertOps.length;

describe("planPaste", () => {
  it("**消す行はページのスナップショットから決め、古い見出しは最後に消す** (Issue #105・#166)", () => {
    const plan = planPaste(page(["a", "b", "c"]), bundle(["x"]));

    expect(plan.deleteOps.flat()).toEqual([
      { delete: "C0" },
      { delete: "C1" },
      { delete: "C2" },
      { delete: "L1" },
    ]);
    expect(plan.oldTitleId).toBe("L1");
    expect(plan.oldLines).toBe(3);
    expect(plan.newLines).toBe(1);
  });

  it("**新しいバンドルは配られない名前 (script.next.js) の見出しごと挿す**。末尾まで続くなら `_end`", () => {
    const plan = planPaste(page(["a"]), bundle(["x", "y"]));

    expect(plan.anchor).toBe("_end");
    expect(plan.insertOps.flat()).toEqual([
      { insertBefore: "_end", text: `${NEXT_TITLE}\n x\n y` },
    ]);
  });

  it("**コード記法の外に何か書いてあれば、その手前に挿す** (末尾に足すとコード記法から外れる)", () => {
    const plan = planPaste(page(["a"], ["", "この下は関係ない"]), bundle(["x"]));

    expect(plan.anchor).toBe("T0");
    // 消すのはコード記法の中と古い見出しだけ
    expect(plan.deleteOps.flat()).toEqual([{ delete: "C0" }, { delete: "L1" }]);
  });

  it("空行は 1 スペースになる (コード記法から外れない)", () => {
    const plan = planPaste(page([]), bundle(["x", "", "y"]));

    expect(plan.insertOps.flat()).toEqual([
      { insertBefore: "_end", text: `${NEXT_TITLE}\n x\n \n y` },
    ]);
  });

  it("コード記法が無いページは断る", () => {
    expect(() => planPaste({ id: "P", lines: [{ id: "L0", text: "dev" }] }, bundle(["x"]))).toThrow(
      /code:script\.js/,
    );
  });

  it("**前に止まった残骸 (script.next.js / script.old.js) があれば断る** (切り替えで見出しを取り違える)", () => {
    for (const leftover of [NEXT_TITLE, OLD_TITLE]) {
      expect(() => planPaste(page(["a"], [leftover, " x"]), bundle(["x"]))).toThrow(/残骸/);
    }
  });
});

describe("planSwap", () => {
  const inserted = (extra: readonly Line[] = []): Page => ({
    id: "P",
    lines: [
      ...page(["a"]).lines,
      { id: "N0", text: NEXT_TITLE },
      { id: "N1", text: " x" },
      ...extra,
    ],
  });

  it("**古い見出しを script.old.js に、新しい見出しを script.js にする 1 回の ops**", () => {
    expect(planSwap(inserted(), "L1")).toEqual([
      { replace: "L1", text: OLD_TITLE },
      { replace: "N0", text: SCRIPT_TITLE },
    ]);
  });

  it("既に切り替わっていれば何もしない (届いたのに応答だけ失敗したとき)", () => {
    const swapped: Page = {
      id: "P",
      lines: [
        { id: "L0", text: "dev" },
        { id: "L1", text: OLD_TITLE },
        { id: "C0", text: " a" },
        { id: "N0", text: SCRIPT_TITLE },
      ],
    };
    expect(planSwap(swapped, "L1")).toBeUndefined();
  });

  it("新しい見出しが 1 つでなければ断る", () => {
    expect(() => planSwap(page(["a"]), "L1")).toThrow(/0 個/);
    expect(() => planSwap(inserted([{ id: "N9", text: NEXT_TITLE }]), "L1")).toThrow(/2 個/);
  });
});

describe("pasteBundle", () => {
  it("**ops を 1 回当てるたびに、配られる script.js は旧か新のどちらか丸ごと** (#166)", async () => {
    const target = editable(page(OLD));

    const plan = await pasteBundle(page(OLD), bundle(NEW), {
      apply: target.apply,
      readPage: target.readPage,
      log: silent,
    });

    expect(plan.insertOps.length).toBeGreaterThan(1);
    expect(plan.deleteOps.length).toBeGreaterThan(1);
    // 挿入がすべて先、切り替えが 1 回、削除がすべて後
    expect(target.applied.map((label) => label.slice(0, 2))).toEqual([
      ...Array(plan.insertOps.length).fill("挿入"),
      "切り",
      ...Array(plan.deleteOps.length).fill("削除"),
    ]);
    const before = OLD.join("\n");
    const after = NEW.join("\n");
    target.snapshots.forEach((snapshot, i) => {
      expect([before, after], `${target.applied[i]} の直後`).toContain(snapshot);
    });
    // 切り替えの 1 回で旧から新へ移る
    expect(target.snapshots.indexOf(after)).toBe(plan.insertOps.length);
    expect(target.texts()).toEqual(FINAL);
  });

  it.each([
    ["挿入 2", { inserts: 1, swapped: false, deletes: 0 }],
    ["切り替え", { inserts: INSERTS, swapped: false, deletes: 0 }],
    ["削除 2", { inserts: INSERTS, swapped: true, deletes: 1 }],
  ])(
    "**%s で止まっても、読み直したページから宛先と消す行を決め直さずに続ける** (Issue #105・#166)",
    async (failAt, expected) => {
      const snapshot = page(OLD);
      const target = editable(snapshot);
      let state: Progress | undefined;

      // 1 回目: failAt で落ちる
      await expect(
        pasteBundle(snapshot, bundle(NEW), {
          apply: async (ops, label) => {
            if (label.startsWith(failAt)) {
              throw new Error("HTTP 503 Service Unavailable");
            }
            await target.apply(ops, label);
          },
          readPage: target.readPage,
          log: silent,
          remember: async (done) => {
            state = done;
          },
        }),
      ).rejects.toThrow(/503[\s\S]*script\.js は/);
      expect(state).toMatchObject({ ...expected, anchor: "_end", oldTitleId: "L1" });

      // 2 回目: **ページを読み直してから**再開する (本物と同じ手順)。挿入済みの行が混ざっている
      const reread = await target.readPage();
      await pasteBundle(reread, bundle(NEW), {
        apply: target.apply,
        readPage: target.readPage,
        log: silent,
        ...(state ? { resume: state } : {}),
      });

      expect(target.texts()).toEqual(FINAL);
      // 止まっていたあいだも含め、配られたのは旧か新のどちらか丸ごと
      for (const snapshot of target.snapshots) {
        expect([OLD.join("\n"), NEW.join("\n")]).toContain(snapshot);
      }
    },
  );

  it("**切り替えが届いたのに応答だけ失敗しても、再開で二重に切り替えない**", async () => {
    const target = editable(page(OLD));
    let state: Progress | undefined;

    await expect(
      pasteBundle(page(OLD), bundle(NEW), {
        apply: async (ops, label) => {
          await target.apply(ops, label);
          if (label === "切り替え") {
            throw new Error("HTTP 503 Service Unavailable");
          }
        },
        readPage: target.readPage,
        log: silent,
        remember: async (done) => {
          state = done;
        },
      }),
    ).rejects.toThrow("503");
    expect(state?.swapped).toBe(false);

    await pasteBundle(await target.readPage(), bundle(NEW), {
      apply: target.apply,
      readPage: target.readPage,
      log: silent,
      ...(state ? { resume: state } : {}),
    });
    expect(target.applied.filter((label) => label === "切り替え")).toHaveLength(1);
    expect(target.texts()).toEqual(FINAL);
  });
});

describe("withRetries (#166)", () => {
  const run = async (failures: readonly string[]) => {
    const waited: number[] = [];
    let calls = 0;
    const result = withRetries(
      async () => {
        const failure = failures[calls++];
        if (failure !== undefined) {
          throw new Error(failure);
        }
      },
      "挿入 1/5",
      { log: silent, wait: async (ms) => waited.push(ms) },
    );
    return { result, waited, calls: () => calls };
  };

  it("**一時的な失敗は、間隔を伸ばしながら通るまで試し直す**", async () => {
    const t = await run([
      "HTTP 503 Service Unavailable",
      "<!DOCTYPE html>",
      "HTTP 409 NotFastForward",
    ]);
    await t.result;
    expect(t.waited).toEqual([2_000, 4_000, 8_000]);
    expect(t.calls()).toBe(4);
  });

  it("**直らない失敗 (422 など) は 1 回で止める**", async () => {
    const t = await run(["HTTP 422 Unprocessable Entity"]);
    await expect(t.result).rejects.toThrow(/試し直しても通らない/);
    expect(t.calls()).toBe(1);
    expect(t.waited).toEqual([]);
  });

  it("試し尽くしたら止める", async () => {
    const t = await run(Array(10).fill("HTTP 503 Service Unavailable"));
    await expect(t.result).rejects.toThrow(`${RETRY_WAITS_MS.length + 1} 回試して通らなかった`);
    expect(t.waited).toEqual(RETRY_WAITS_MS);
  });

  it("**待ちは合計 3 分以上で、1 回は 60 秒まで** (大きいページの 503 が 1 分以上続く。#180)", () => {
    const total = RETRY_WAITS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(180_000);
    expect(Math.max(...RETRY_WAITS_MS)).toBeLessThanOrEqual(60_000);
    // 間隔は減らない
    RETRY_WAITS_MS.forEach((ms, i) => {
      expect(ms).toBeGreaterThanOrEqual(RETRY_WAITS_MS[i - 1] ?? 0);
    });
  });

  it("isRetryable: 4xx の一部だけを直らない失敗とみなす", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryable(`Command failed\nHTTP ${status} x`)).toBe(false);
    }
    for (const message of [
      "HTTP 409 NotFastForward",
      "HTTP 503",
      "HTTP 502",
      "<html>",
      "ECONNRESET",
    ]) {
      expect(isRetryable(message)).toBe(true);
    }
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
