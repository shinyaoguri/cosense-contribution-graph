import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGraphDialog,
  DIALOG_TITLE,
  GRAPH_HEIGHT,
  GRAPH_WIDTH,
} from "../../src/userscript/graph-dialog.ts";
import {
  INITIAL_PROJECT_GRAPHS,
  TOTAL_LABEL,
  type ViewModel,
} from "../../src/userscript/viewer.ts";

// jsdom 30 の <dialog> は open 属性しか無い。showModal と close を差し替える (sign-in-dialog.test.ts と同じ)
const prototype = HTMLDialogElement.prototype as HTMLDialogElement & {
  showModal?: () => void;
  close?: () => void;
};
const original = { showModal: prototype.showModal, close: prototype.close };

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "table"] as const;

beforeEach(() => {
  prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

afterEach(() => {
  prototype.showModal = original.showModal;
  prototype.close = original.close;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const url = (name: string) => `https://grass.soui.dev/v1/g/${name.padEnd(32, "0")}.svg`;

function graphs(projects: { label: string; sent: boolean }[]): ViewModel {
  return {
    kind: "graphs",
    total: { label: TOTAL_LABEL, url: url("aa"), sent: true },
    projects: projects.map((p, i) => ({ ...p, url: url(`b${i}`) })),
  };
}

function setup(writeText: (text: string) => Promise<void> = () => Promise.resolve()) {
  const copied: string[] = [];
  const dialog = createGraphDialog(document, {
    writeText: (text) => {
      copied.push(text);
      return writeText(text);
    },
  });
  const find = () => document.querySelector("dialog");
  const buttons = (text: string) =>
    [...(find()?.querySelectorAll("button") ?? [])].filter((b) => b.textContent === text);
  return { dialog, copied, find, buttons };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createGraphDialog", () => {
  it("**理由の文言だけのときは画像を出さない**", () => {
    const t = setup();

    t.dialog.open({ kind: "message", lines: ["この端末は未登録", "登録してください"] });

    const node = t.find();
    expect(node?.hasAttribute("open")).toBe(true);
    expect(node?.querySelector("h2")?.textContent).toBe(DIALOG_TITLE);
    expect([...(node?.querySelectorAll("p") ?? [])].map((p) => p.textContent)).toContain(
      "この端末は未登録",
    );
    expect(node?.querySelectorAll("img")).toHaveLength(0);
  });

  it("**送れた草は img で出す。** 大きさ・alt・遅延読み込み・Referer を送らない指定が付き、属性のハンドラは無い", () => {
    const t = setup();

    t.dialog.open(graphs([{ label: "alpha", sent: true }]));

    const images = [...(t.find()?.querySelectorAll("img") ?? [])];
    expect(images.map((img) => img.getAttribute("src"))).toEqual([url("aa"), url("b0")]);
    for (const img of images) {
      expect(img.width).toBe(GRAPH_WIDTH);
      expect(img.height).toBe(GRAPH_HEIGHT);
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(img.alt).toMatch(/の草$/);
    }
    const handlers = [...(t.find()?.querySelectorAll("*") ?? [])].flatMap((node) =>
      [...node.attributes].filter((attr) => attr.name.startsWith("on")),
    );
    expect(handlers).toEqual([]);
    expect(t.find()?.querySelector("h4")?.textContent).toBe(TOTAL_LABEL);
  });

  it("**読めなかった画像は文言に置き換える**", () => {
    const t = setup();
    t.dialog.open(graphs([]));

    t.find()?.querySelector("img")?.dispatchEvent(new Event("error"));

    expect(t.find()?.querySelectorAll("img")).toHaveLength(0);
    expect(t.find()?.textContent).toContain("草を表示できませんでした");
  });

  it("**このブラウザから送れていない草は、押されるまで読まない**", () => {
    const t = setup();
    t.dialog.open(graphs([{ label: "beta", sent: false }]));

    expect(
      [...(t.find()?.querySelectorAll("img") ?? [])].map((i) => i.getAttribute("src")),
    ).toEqual([url("aa")]);
    expect(t.find()?.textContent).toContain("このブラウザからはまだ送っていません");

    t.buttons("表示してみる")[0]?.click();

    expect(
      [...(t.find()?.querySelectorAll("img") ?? [])].map((i) => i.getAttribute("src")),
    ).toEqual([url("aa"), url("b0")]);
  });

  it(`**プロジェクト別は ${INITIAL_PROJECT_GRAPHS} 件まで出し、残りは押すと出す**`, () => {
    const t = setup();
    const projects = Array.from({ length: INITIAL_PROJECT_GRAPHS + 2 }, (_, i) => ({
      label: `p${i}`,
      sent: true,
    }));
    t.dialog.open(graphs(projects));

    expect(t.find()?.querySelectorAll("img")).toHaveLength(1 + INITIAL_PROJECT_GRAPHS);

    t.buttons("ほか 2 件を表示")[0]?.click();

    expect(t.find()?.querySelectorAll("img")).toHaveLength(1 + INITIAL_PROJECT_GRAPHS + 2);
    expect(t.buttons("ほか 2 件を表示")).toHaveLength(0);
    expect([...(t.find()?.querySelectorAll("h4") ?? [])].map((h) => h.textContent)).toEqual([
      TOTAL_LABEL,
      ...projects.map((p) => p.label),
    ]);
  });

  it("記録したプロジェクトが無ければそう書く", () => {
    const t = setup();
    t.dialog.open(graphs([]));

    expect(t.find()?.textContent).toContain("直近 30 日に記録したプロジェクトはまだありません");
  });

  it("**コピーは押した処理の中で同期に呼び**、できたらそう書く", async () => {
    const t = setup();
    t.dialog.open(graphs([{ label: "alpha", sent: true }]));

    t.buttons("URL をコピー")[1]?.click();

    // await の前に呼ばれている
    expect(t.copied).toEqual([url("b0")]);
    await settle();
    expect(t.find()?.textContent).toContain("コピーしました");
  });

  it("**コピーできなければ、選べる欄に URL を出す** (押し直しても欄は 1 つ)", async () => {
    const t = setup(() => Promise.reject(new Error("denied")));
    t.dialog.open(graphs([]));

    t.buttons("URL をコピー")[0]?.click();
    await settle();
    t.buttons("URL をコピー")[0]?.click();
    await settle();

    const fields = [...(t.find()?.querySelectorAll("input") ?? [])];
    expect(fields).toHaveLength(1);
    expect(fields[0]?.readOnly).toBe(true);
    expect(fields[0]?.value).toBe(url("aa"));
    expect(t.find()?.textContent).toContain("コピーできなかった");
  });

  it("**キー入力・貼り付け・コピーをダイアログの外へ伝えない**", () => {
    const t = setup();
    t.dialog.open(graphs([]));
    const seen: string[] = [];
    for (const type of ["keydown", "keyup", "keypress", "paste", "copy", "cut"]) {
      document.body.addEventListener(type, () => seen.push(type));
    }

    for (const type of ["keydown", "keyup", "keypress", "paste", "copy", "cut"]) {
      t.buttons("URL をコピー")[0]?.dispatchEvent(new Event(type, { bubbles: true }));
    }

    expect(seen).toEqual([]);
  });

  it("**開き直すと前のダイアログを消す。** 閉じる・Esc で消える", () => {
    const t = setup();
    t.dialog.open(graphs([]));
    t.dialog.open({ kind: "message", lines: ["2 回目"] });

    expect(document.querySelectorAll("dialog")).toHaveLength(1);
    expect(t.find()?.textContent).toContain("2 回目");

    t.buttons("閉じる")[0]?.click();
    expect(document.querySelectorAll("dialog")).toHaveLength(0);

    t.dialog.open(graphs([]));
    // Esc はブラウザが close を呼ぶ
    t.find()?.close();
    expect(document.querySelectorAll("dialog")).toHaveLength(0);
  });

  it("**草の URL をコンソールに出さない**", async () => {
    const spies = CONSOLE_METHODS.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const t = setup(() => Promise.reject(new Error("denied")));

    t.dialog.open(
      graphs([
        { label: "alpha", sent: true },
        { label: "beta", sent: false },
      ]),
    );
    for (const copy of t.buttons("URL をコピー")) {
      copy.click();
    }
    t.buttons("表示してみる")[0]?.click();
    for (const img of t.find()?.querySelectorAll("img") ?? []) {
      img.dispatchEvent(new Event("error"));
    }
    await settle();

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
