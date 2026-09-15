import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGraphDialog,
  DIALOG_TITLE,
  GRAPH_HEIGHT,
  GRAPH_WIDTH,
  LOCAL_PROJECT_SCALE,
} from "../../src/userscript/graph-dialog.ts";
import { createStore } from "../../src/userscript/store.ts";
import {
  describeLocal,
  INITIAL_PROJECT_GRAPHS,
  LOCAL_TOTAL_LABEL,
  type LocalView,
  localRangeStart,
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

const TODAY = "2026-09-15";

/** このブラウザの記録。`projects` の名前ごとに、今日 1 分だけ書いた記録を作る */
function localView(projects: readonly string[] = []): LocalView {
  const map = new Map<string, string>();
  const store = createStore(
    { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) },
    () => undefined,
  );
  projects.forEach((project, i) => {
    store.record({ kind: "write", project, day: TODAY, minute: i });
  });
  return describeLocal(store.readRange(localRangeStart(TODAY), TODAY), TODAY, "");
}

function graphs(projects: { label: string; sent: boolean }[], local = localView()): ViewModel {
  return {
    integrated: {
      kind: "graphs",
      total: { label: TOTAL_LABEL, url: url("aa"), sent: true },
      projects: projects.map((p, i) => ({ ...p, url: url(`b${i}`) })),
    },
    local,
  };
}

function message(...lines: string[]): ViewModel {
  return { integrated: { kind: "message", lines }, local: localView() };
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
  const sections = () => [...(find()?.querySelectorAll("section") ?? [])];
  const buttons = (text: string) =>
    [...(find()?.querySelectorAll("button") ?? [])].filter((b) => b.textContent === text);
  return { dialog, copied, find, buttons, sections };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createGraphDialog", () => {
  it("**理由の文言だけのときは画像を出さない**", () => {
    const t = setup();

    t.dialog.open(message("この端末は未登録", "登録してください"));

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
    expect([...(t.sections()[0]?.querySelectorAll("h4") ?? [])].map((h) => h.textContent)).toEqual([
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
    t.dialog.open(message("2 回目"));

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

  it("**全端末を統合した記録を上に、このブラウザの記録を下に置く**", () => {
    const t = setup();

    t.dialog.open(graphs([{ label: "alpha", sent: true }]));

    expect(t.sections().map((section) => section.querySelector("h3")?.textContent)).toEqual([
      "全端末を統合した記録",
      "このブラウザの記録",
    ]);
  });

  it("**このブラウザの記録は DOM の SVG で描き、マスにツールチップを付ける。** プロジェクト別は小さく", () => {
    const t = setup();
    const local = localView(["alpha", "beta"]);

    t.dialog.open(graphs([], local));

    const section = t.sections()[1];
    expect([...(section?.querySelectorAll("h4") ?? [])].map((h) => h.textContent)).toEqual([
      LOCAL_TOTAL_LABEL,
      "alpha",
      "beta",
    ]);
    const svgs = [...(section?.querySelectorAll("svg") ?? [])];
    expect(svgs).toHaveLength(3);
    expect(svgs[0]?.getAttribute("aria-label")).toBe(`${LOCAL_TOTAL_LABEL} の草`);
    const width = Number(svgs[0]?.getAttribute("width"));
    expect(Number(svgs[1]?.getAttribute("width"))).toBeCloseTo(width * LOCAL_PROJECT_SCALE);
    const titles = [...(svgs[0]?.querySelectorAll("rect > title") ?? [])].map((x) => x.textContent);
    expect(titles).toHaveLength(365);
    expect(titles.at(-1)).toBe(
      `${TODAY} — 書き 2 分 / 読み 0 分 / 0 ページ編集 / 0 ページ新規作成`,
    );
    expect(titles[0]).toMatch(/— 記録なし$/);
    expect(section?.querySelectorAll("img")).toHaveLength(0);
  });

  it(`**このブラウザの記録もプロジェクト別は ${INITIAL_PROJECT_GRAPHS} 件まで**`, () => {
    const t = setup();
    const names = Array.from({ length: INITIAL_PROJECT_GRAPHS + 1 }, (_, i) => `p${i}`);

    t.dialog.open(graphs([], localView(names)));

    const section = () => t.sections()[1];
    expect(section()?.querySelectorAll("svg")).toHaveLength(1 + INITIAL_PROJECT_GRAPHS);
    t.buttons("ほか 1 件を表示")[0]?.click();
    expect(section()?.querySelectorAll("svg")).toHaveLength(2 + INITIAL_PROJECT_GRAPHS);
  });

  it("**統合の方が理由の文言だけでも、このブラウザの記録は出す**", () => {
    const t = setup();

    t.dialog.open({
      integrated: { kind: "message", lines: ["未登録"] },
      local: localView(["alpha"]),
    });

    expect(t.sections()[0]?.textContent).toContain("未登録");
    expect(t.sections()[1]?.querySelectorAll("svg")).toHaveLength(2);
  });

  it("このブラウザにプロジェクトの記録が無ければそう書く", () => {
    const t = setup();

    t.dialog.open(graphs([]));

    expect(t.sections()[1]?.textContent).toContain(
      "このブラウザで数えたプロジェクトはまだありません",
    );
  });
});
