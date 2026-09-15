import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGraphDialog,
  GRAPH_HEIGHT,
  GRAPH_WIDTH,
  LOCAL_PROJECT_SCALE,
  LOCAL_SUMMARY,
  type SendNowResult,
} from "../../src/userscript/graph-dialog.ts";
import { MENU_TITLE, SETTINGS_LABEL } from "../../src/userscript/settings.ts";
import { createStore } from "../../src/userscript/store.ts";
import {
  describeLocal,
  INITIAL_PROJECT_GRAPHS,
  LOCAL_TOTAL_LABEL,
  type LocalView,
  localRangeStart,
  SEND_NOW_LABEL,
  type SyncView,
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

const SYNC: SyncView = { lines: ["このブラウザの記録は送信済みです。"], canSend: false };

function graphs(
  projects: { label: string; sent: boolean }[],
  local = localView(),
  totalSent = true,
  sync: SyncView = SYNC,
): ViewModel {
  return {
    integrated: {
      kind: "graphs",
      total: { label: TOTAL_LABEL, url: url("aa"), sent: totalSent },
      projects: projects.map((p, i) => ({ ...p, url: url(`b${i}`) })),
      sync,
    },
    local,
  };
}

function message(...lines: string[]): ViewModel {
  return { integrated: { kind: "message", lines }, local: localView() };
}

function setup(
  writeText: (text: string) => Promise<void> = () => Promise.resolve(),
  sendNow: () => Promise<SendNowResult> = () =>
    Promise.resolve({ text: "送りました。", view: SYNC, refresh: false }),
) {
  const copied: string[] = [];
  const settings = { count: 0 };
  const sent = { count: 0 };
  const dialog = createGraphDialog(document, {
    writeText: (text) => {
      copied.push(text);
      return writeText(text);
    },
  });
  /** 「設定」のハンドラを付けて開く。呼ばれた回数は `settings.count` で見る */
  const open = (model: ViewModel) =>
    dialog.open(model, {
      openSettings: () => {
        settings.count++;
      },
      sendNow: () => {
        sent.count++;
        return sendNow();
      },
    });
  const find = () => document.querySelector("dialog");
  const sections = () => [...(find()?.querySelectorAll("section") ?? [])];
  /** 畳んだ「このブラウザの記録」 */
  const local = () => find()?.querySelector("details") ?? undefined;
  const buttons = (text: string) =>
    [...(find()?.querySelectorAll("button") ?? [])].filter((b) => b.textContent === text);
  return { open, copied, settings, sent, find, buttons, sections, local };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createGraphDialog", () => {
  it("**「設定」を押すと、このダイアログを閉じてから開く** (2 枚重ねない。Issue #95)", () => {
    const t = setup();
    t.open(graphs([]));

    const button = t.buttons(SETTINGS_LABEL)[0];
    expect(button).toBeDefined();
    button?.click();

    expect(t.settings.count).toBe(1);
    // 閉じてから呼ぶので、ハンドラから見てダイアログは残っていない
    expect(t.find()).toBeNull();
  });

  it("**「設定」は押されるまで開かない**", () => {
    const t = setup();

    t.open(graphs([]));

    expect(t.settings.count).toBe(0);
  });

  it("**理由の文言だけのときは画像を出さない**", () => {
    const t = setup();

    t.open(message("この端末は未登録", "登録してください"));

    const node = t.find();
    expect(node?.hasAttribute("open")).toBe(true);
    expect(node?.querySelector("h2")?.textContent).toBe(MENU_TITLE);
    expect([...(node?.querySelectorAll("p") ?? [])].map((p) => p.textContent)).toContain(
      "この端末は未登録",
    );
    expect(node?.querySelectorAll("img")).toHaveLength(0);
  });

  it("**送れた草は img で出す。** 大きさ・alt・遅延読み込み・Referer を送らない指定が付き、属性のハンドラは無い", () => {
    const t = setup();

    t.open(graphs([{ label: "alpha", sent: true }]));

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
    t.open(graphs([]));

    t.find()?.querySelector("img")?.dispatchEvent(new Event("error"));

    expect(t.find()?.querySelectorAll("img")).toHaveLength(0);
    expect(t.find()?.textContent).toContain("草を表示できませんでした");
  });

  it("**このブラウザから送れていない草は、押されるまで読まない**", () => {
    const t = setup();
    t.open(graphs([{ label: "beta", sent: false }]));

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
    t.open(graphs(projects));

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
    t.open(graphs([]));

    expect(t.find()?.textContent).toContain("直近 30 日に記録したプロジェクトはまだありません");
  });

  it("**コピーは押した処理の中で同期に呼び**、できたらそう書く", async () => {
    const t = setup();
    t.open(graphs([{ label: "alpha", sent: true }]));

    t.buttons("URL をコピー")[1]?.click();

    // await の前に呼ばれている
    expect(t.copied).toEqual([url("b0")]);
    await settle();
    expect(t.find()?.textContent).toContain("コピーしました");
  });

  it("**コピーできなければ、選べる欄に URL を出す** (押し直しても欄は 1 つ)", async () => {
    const t = setup(() => Promise.reject(new Error("denied")));
    t.open(graphs([]));

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
    t.open(graphs([]));
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
    t.open(graphs([]));
    t.open(message("2 回目"));

    expect(document.querySelectorAll("dialog")).toHaveLength(1);
    expect(t.find()?.textContent).toContain("2 回目");

    t.buttons("閉じる")[0]?.click();
    expect(document.querySelectorAll("dialog")).toHaveLength(0);

    t.open(graphs([]));
    // Esc はブラウザが close を呼ぶ
    t.find()?.close();
    expect(document.querySelectorAll("dialog")).toHaveLength(0);
  });

  it("**草の URL をコンソールに出さない**", async () => {
    const spies = CONSOLE_METHODS.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const t = setup(() => Promise.reject(new Error("denied")));

    t.open(
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

  it("**同期の状態を合算の草の直後に出し、送るものが無ければボタンを無効にする** (Issue #102)", () => {
    const t = setup();

    t.open(
      graphs([], localView(), true, {
        lines: ["送信済みです。", "自動で送ります。"],
        canSend: false,
      }),
    );

    const send = t.buttons(SEND_NOW_LABEL)[0];
    expect(send?.disabled).toBe(true);
    const texts = [...(t.sections()[0]?.querySelectorAll("p") ?? [])].map((p) => p.textContent);
    expect(texts).toContain("送信済みです。");
    expect(texts).toContain("自動で送ります。");
    // 押していないので呼ばれない
    expect(t.sent.count).toBe(0);
  });

  it("**押すと送り、結果の文言と新しい状態に差し替える**", async () => {
    const after: SyncView = { lines: ["このブラウザの記録は送信済みです。"], canSend: false };
    const t = setup(undefined, () =>
      Promise.resolve({ text: "送りました。", view: after, refresh: false }),
    );
    t.open(
      graphs([], localView(), true, {
        lines: ["まだ送れていない記録が 2 日分あります。"],
        canSend: true,
      }),
    );

    const send = t.buttons(SEND_NOW_LABEL)[0];
    send?.click();
    // 待っている間は押せない
    expect(send?.disabled).toBe(true);
    await settle();

    expect(t.sent.count).toBe(1);
    expect(t.find()?.textContent).toContain("送りました。");
    const texts = [...(t.sections()[0]?.querySelectorAll("p") ?? [])].map((p) => p.textContent);
    expect(texts).toContain("このブラウザの記録は送信済みです。");
    expect(texts).not.toContain("まだ送れていない記録が 2 日分あります。");
    // 新しい状態で押せなくなる
    expect(send?.disabled).toBe(true);
  });

  it("**送れたら表示中の草を取り直す。** 新しい絵が読めてから差し替える (失敗しても古い絵を残す)", async () => {
    const t = setup(undefined, () =>
      Promise.resolve({ text: "送りました。", view: SYNC, refresh: true }),
    );
    t.open(
      graphs([{ label: "alpha", sent: true }], localView(), true, { lines: [], canSend: true }),
    );
    const created: HTMLImageElement[] = [];
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const node = original(tag);
      if (tag === "img") created.push(node as HTMLImageElement);
      return node;
    });

    t.buttons(SEND_NOW_LABEL)[0]?.click();
    await settle();

    // 表示中の 2 枚ぶんを、キャッシュを外すクエリ付きで取り直す
    expect(created.map((img) => img.getAttribute("src"))).toEqual([
      expect.stringMatching(/\/aa0+\.svg\?r=\d+$/),
      expect.stringMatching(/\/b00+\.svg\?r=\d+$/),
    ]);
    // 読めるまでは古い絵のまま
    expect(
      [...(t.find()?.querySelectorAll("img") ?? [])].map((i) => i.getAttribute("src")),
    ).toEqual([url("aa"), url("b0")]);

    created[0]?.dispatchEvent(new Event("load"));
    expect(t.find()?.querySelector("img")?.getAttribute("src")).toMatch(/\?r=\d+$/);
  });

  it("**取り直しのクエリはコピーする URL に混ぜない** (他人に渡すもの)", async () => {
    const t = setup(undefined, () =>
      Promise.resolve({ text: "送りました。", view: SYNC, refresh: true }),
    );
    t.open(graphs([], localView(), true, { lines: [], canSend: true }));

    t.buttons(SEND_NOW_LABEL)[0]?.click();
    await settle();
    t.buttons("URL をコピー")[0]?.click();
    await settle();

    expect(t.copied).toEqual([url("aa")]);
  });

  it("**統合の草を主にし、このブラウザの記録は畳む** (Issue #101)", () => {
    const t = setup();

    t.open(graphs([{ label: "alpha", sent: true }]));

    // 表に出る section は統合だけ
    expect(t.sections().map((section) => section.querySelector("h3")?.textContent)).toEqual([
      "全端末を統合した記録",
    ]);
    const details = t.local();
    expect(details?.open).toBe(false);
    // summary は details の直下の最初の子 (そうでないと開く操作が効かない)
    expect(details?.firstElementChild?.tagName.toLowerCase()).toBe("summary");
    expect(details?.firstElementChild?.textContent).toBe(LOCAL_SUMMARY);
    // 統合が先、畳んだ方が後
    expect(t.sections()[0]?.compareDocumentPosition(details as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("**まだ 1 件も送れていないなら、このブラウザの記録を開いて出す** (見るものがこれしか無い。Issue #100)", () => {
    const t = setup();

    t.open(graphs([], localView(["alpha"]), false));

    expect(t.local()?.open).toBe(true);
    // 合算も「表示してみる」を押すまで読まない
    expect(t.find()?.querySelectorAll("img")).toHaveLength(0);
  });

  it("**このブラウザの記録は DOM の SVG で描き、マスにツールチップを付ける。** プロジェクト別は小さく", () => {
    const t = setup();
    const local = localView(["alpha", "beta"]);

    t.open(graphs([], local));

    const section = t.local();
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
    // 記録のある最も古い日より前は「計測開始前」(活動の無い日と区別する。Issue #80)
    expect(titles[0]).toMatch(/計測開始前$/);
    expect(section?.querySelectorAll("img")).toHaveLength(0);
  });

  it(`**このブラウザの記録もプロジェクト別は ${INITIAL_PROJECT_GRAPHS} 件まで**`, () => {
    const t = setup();
    const names = Array.from({ length: INITIAL_PROJECT_GRAPHS + 1 }, (_, i) => `p${i}`);

    t.open(graphs([], localView(names)));

    const section = () => t.local();
    expect(section()?.querySelectorAll("svg")).toHaveLength(1 + INITIAL_PROJECT_GRAPHS);
    t.buttons("ほか 1 件を表示")[0]?.click();
    expect(section()?.querySelectorAll("svg")).toHaveLength(2 + INITIAL_PROJECT_GRAPHS);
  });

  it("**統合の方が理由の文言だけでも、このブラウザの記録は出す**", () => {
    const t = setup();

    t.open({
      integrated: { kind: "message", lines: ["未登録"] },
      local: localView(["alpha"]),
    });

    expect(t.sections()[0]?.textContent).toContain("未登録");
    const details = t.local();
    expect(details?.querySelectorAll("svg")).toHaveLength(2);
    // 見るものがこれしか無いので開いて出す
    expect(details?.open).toBe(true);
  });

  it("このブラウザにプロジェクトの記録が無ければそう書く", () => {
    const t = setup();

    t.open(graphs([]));

    expect(t.local()?.textContent).toContain("このブラウザで数えたプロジェクトはまだありません");
  });
});
