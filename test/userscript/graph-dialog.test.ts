import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGraphDialog,
  GRAPH_HEIGHT,
  GRAPH_WIDTH,
  OVERVIEW_HEIGHT,
  OVERVIEW_WIDTH,
  type SendNowResult,
} from "../../src/userscript/graph-dialog.ts";
import { MENU_TITLE, SETTINGS_LABEL } from "../../src/userscript/settings.ts";
import {
  INITIAL_PROJECT_GRAPHS,
  type IntegratedView,
  SEND_NOW_LABEL,
  type SyncView,
  TOTAL_LABEL,
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
/** 囲みの見出し (説明の `<details>` の中の見出しと分ける) */
const CARD_TITLE = "section > h4";
/** 草の画像 (概観の画像と分ける) */
const GRASS = 'img[alt$="の草"]';
/** 活動の概観の画像 (ADR-0021) */
const OVERVIEW = 'img[alt$="の活動の概観"]';
const dataOf = (name: string) =>
  `https://grass.soui.dev/v1/g/${name.padEnd(32, "0")}/${"f".repeat(32)}.json`;
const overviewOf = (name: string) =>
  `https://grass.soui.dev/v1/g/${name.padEnd(32, "0")}/overview.svg`;

const SYNC: SyncView = { lines: ["このブラウザの記録は送信済みです。"], canSend: false };

function graphs(
  projects: { label: string; sent: boolean }[],
  totalSent = true,
  sync: SyncView = SYNC,
): IntegratedView {
  return {
    kind: "graphs",
    total: {
      label: TOTAL_LABEL,
      url: url("aa"),
      overviewUrl: overviewOf("aa"),
      dataUrl: dataOf("aa"),
      sent: totalSent,
    },
    projects: projects.map((p, i) => ({
      ...p,
      url: url(`b${i}`),
      overviewUrl: overviewOf(`b${i}`),
      dataUrl: dataOf(`b${i}`),
    })),
    sync,
  };
}

function message(...lines: string[]): IntegratedView {
  return { kind: "message", lines };
}

const INSIDE = 200;
const OUTSIDE = 20;

/**
 * 押して離す。jsdom は矩形を持たないので、ダイアログを (100, 100)〜(500, 400) に置いたことにする。
 * `pressed` / `released` は押した位置と離した位置 (x・y とも同じ値)。`pressTarget` を渡すと、押したのは中の要素
 */
function clickAt(
  dialog: HTMLDialogElement | null,
  pressed: number,
  released: number,
  pressTarget?: Element | null,
) {
  if (dialog === null) {
    return;
  }
  dialog.getBoundingClientRect = () => new DOMRect(100, 100, 400, 300);
  const at = (position: number) => ({ bubbles: true, clientX: position, clientY: position });
  (pressTarget ?? dialog).dispatchEvent(new MouseEvent("pointerdown", at(pressed)));
  // 押した所と離した所が違えば、click は共通の祖先 (ここではダイアログ) に届く
  const clickTarget = pressed === released ? (pressTarget ?? dialog) : dialog;
  clickTarget.dispatchEvent(new MouseEvent("click", at(released)));
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
  const open = (view: IntegratedView) =>
    dialog.open(view, {
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
  const buttons = (text: string) =>
    [...(find()?.querySelectorAll("button") ?? [])].filter((b) => b.textContent === text);
  return { open, copied, settings, sent, find, buttons, sections };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("外側のクリックで閉じる (2026-09-24)", () => {
  it("**「閉じる」ボタンは出さない**", () => {
    const t = setup();
    t.open(graphs([]));

    expect(t.buttons("閉じる")).toEqual([]);
  });

  it("**背景で押して背景で離すと閉じる**", () => {
    const t = setup();
    t.open(graphs([]));

    clickAt(t.find(), OUTSIDE, OUTSIDE);

    expect(t.find()).toBeNull();
  });

  it("**中身のクリックでは閉じない** (ダイアログの余白・中の要素)", () => {
    const t = setup();
    t.open(graphs([]));

    clickAt(t.find(), INSIDE, INSIDE);
    const heading = t.find()?.querySelector("h2");
    clickAt(t.find(), INSIDE, INSIDE, heading);
    // 中の要素なら、矩形の外にはみ出した位置でも閉じない (target で見分ける)
    clickAt(t.find(), OUTSIDE, OUTSIDE, heading);

    expect(t.find()).not.toBeNull();
  });

  it("**中で押して外で離しても閉じない** (文字を選んだまま外へ出たとき)", () => {
    const t = setup();
    t.open(graphs([]));

    clickAt(t.find(), INSIDE, OUTSIDE);

    expect(t.find()).not.toBeNull();
  });
});

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
    expect(node?.querySelectorAll<HTMLImageElement>(GRASS)).toHaveLength(0);
  });

  it("**送れた草は img で出す。** 大きさ・alt・遅延読み込み・Referer を送らない指定が付き、属性のハンドラは無い", () => {
    const t = setup();

    t.open(graphs([{ label: "alpha", sent: true }]));

    const images = [...(t.find()?.querySelectorAll<HTMLImageElement>(GRASS) ?? [])];
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
    expect(t.find()?.querySelector(CARD_TITLE)?.textContent).toBe(TOTAL_LABEL);
  });

  it("**1 つの草に属するものを 1 つの囲みにまとめる** (どのコピーがどの画像のものか読み取れるように)", () => {
    const t = setup();
    const projects = [
      { label: "project-a", sent: true },
      { label: "project-b", sent: true },
    ];
    t.open(graphs(projects));

    // 草ごとの囲み。外側のセクションは除く
    const blocks = t
      .sections()
      .filter(
        (node) => node.querySelector(CARD_TITLE) !== null && node.querySelector("section") === null,
      );

    expect(blocks).toHaveLength(1 + projects.length);
    for (const block of blocks) {
      // 見出し・画像・概観が 1 つずつ、コピーが 3 つ (草・概観・日ごとの数値) と JSON を開くリンクが同じ囲みの中にある
      expect(block.querySelectorAll(CARD_TITLE)).toHaveLength(1);
      expect(block.querySelectorAll<HTMLImageElement>(GRASS)).toHaveLength(1);
      expect(block.querySelectorAll<HTMLImageElement>(OVERVIEW)).toHaveLength(1);
      expect(
        [...block.querySelectorAll("button")].filter((b) => b.textContent === "URL をコピー"),
      ).toHaveLength(3);
      expect([...block.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["開く"]);
      expect(block.style.border).not.toBe("");
    }
  });

  it("**枠の内側より枠と枠の間を広く取る** (囲みが見えなくても近接でまとまりが読める)", () => {
    const t = setup();
    t.open(graphs([{ label: "project-a", sent: true }]));

    const block = t.sections().find((node) => node.style.border !== "");
    const padding = Number.parseInt(block?.style.padding ?? "0", 10);
    const margin = Number.parseInt(block?.style.margin ?? "0", 10);

    expect(margin).toBeGreaterThan(padding);
  });

  it("**コピーボタンは対象を名乗る** (支援技術でも対応が分かる)", () => {
    const t = setup();
    t.open(graphs([{ label: "project-a", sent: true }]));

    const labels = t.buttons("URL をコピー").map((b) => b.getAttribute("aria-label"));

    expect(labels).toEqual([
      `${TOTAL_LABEL} の草の URL をコピー`,
      `${TOTAL_LABEL} の活動の概観の URL をコピー`,
      `${TOTAL_LABEL} の日ごとの数値の URL をコピー`,
      "project-a の草の URL をコピー",
      "project-a の活動の概観の URL をコピー",
      "project-a の日ごとの数値の URL をコピー",
    ]);
  });

  it("**3 つのコピーはそれぞれの URL を書き、JSON は別のタブで Referer を送らずに開く** (#164)", async () => {
    const t = setup();
    t.open(graphs([]));

    for (const copy of t.buttons("URL をコピー")) {
      copy.click();
    }
    await settle();
    expect(t.copied).toEqual([url("aa"), overviewOf("aa"), dataOf("aa")]);

    const open = t
      .find()
      ?.querySelector<HTMLAnchorElement>('a[aria-label$="の日ごとの数値を開く"]');
    expect(open?.href).toBe(dataOf("aa"));
    expect(open?.target).toBe("_blank");
    expect(open?.rel).toBe("noopener noreferrer");
    // 渡すと内訳まで読めることを添える
    expect(t.find()?.textContent).toContain("日ごとの内訳まで読めます");
  });

  it("**概観と「共有する」の欄を草の下の 1 行に並べ、狭ければ折り返す** (右側を空けない。#164)", () => {
    const t = setup();
    t.open(graphs([]));

    const overview = t.find()?.querySelector<HTMLImageElement>(OVERVIEW)?.parentElement;
    const row = overview?.parentElement;
    expect(row?.style.display).toBe("flex");
    expect(row?.style.flexWrap).toBe("wrap");
    expect(row?.children).toHaveLength(2);
    expect(row?.children[1]?.textContent).toContain("共有する");
    // 草の後ろにある
    const grass = t.find()?.querySelector(GRASS);
    expect(
      grass && row && grass.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("**何をどう数えて描いているかを、畳んだ説明で添える** (#164)", () => {
    const t = setup();
    t.open(graphs([]));

    const details = t.find()?.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toContain("草と活動の概観の見方");
    const text = details?.textContent ?? "";
    for (const phrase of [
      "1 分",
      "3 分以内",
      "四分位",
      "作る",
      "育てる",
      "関わる",
      "読む",
      "ページ名",
    ]) {
      expect(text).toContain(phrase);
    }
    // 理由の文言だけのときも出す
    const u = setup();
    u.open(message("この端末は未登録"));
    expect(u.find()?.querySelector("details")).not.toBeNull();
  });

  it("**説明の見出しは、開けることが分かる帯にする** (#170)", () => {
    const t = setup();
    t.open(graphs([]));
    const details = t.find()?.querySelector("details");
    const summary = details?.querySelector("summary");
    // 既定の三角を消し、枠と背景でボタンらしく見せる
    expect(summary?.style.listStyle).toBe("none");
    expect(summary?.style.border).not.toBe("");
    expect(summary?.style.background).not.toBe("");
    // 「?」・開閉の文言・山形は飾りで、読み上げない (開閉の状態は details が伝える)
    const decorations = [...(summary?.querySelectorAll("[aria-hidden='true']") ?? [])];
    expect(decorations.map((node) => node.textContent)).toEqual(["?", "開く", "›"]);
    const chevron = decorations[2] as HTMLElement;
    expect(chevron.style.transform).toBe("");

    if (details === null || details === undefined) {
      throw new Error("details が無い");
    }
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    expect(decorations[1]?.textContent).toBe("閉じる");
    expect(chevron.style.transform).toBe("rotate(90deg)");

    details.open = false;
    details.dispatchEvent(new Event("toggle"));
    expect(decorations[1]?.textContent).toBe("開く");
    expect(chevron.style.transform).toBe("");
  });

  it("説明の図の読み方は、長さが平方根で % は分の割合であることを書く (#169)", () => {
    const t = setup();
    t.open(graphs([]));
    const text = t.find()?.querySelector("details")?.textContent ?? "";
    expect(text).toContain("平方根");
    expect(text).toContain("% は分の割合");
  });

  it("**下端に配布ページ・ソースコード・プライバシーポリシーへのリンクを置く** (別のタブで開く。#164)", () => {
    const t = setup();
    t.open(graphs([]));

    const links = [...(t.find()?.querySelectorAll<HTMLAnchorElement>("nav a") ?? [])];
    expect(links.map((a) => [a.textContent, a.href])).toEqual([
      ["配布ページ (Cosense)", "https://scrapbox.io/cosense-grass/"],
      ["ソースコード (GitHub)", "https://github.com/shinyaoguri/cosense-contribution-graph"],
      ["プライバシーポリシー", "https://grass.soui.dev/ja/privacy"], // ダイアログが日本語なので日本語版 (ADR-0022)
    ]);
    for (const link of links) {
      expect([link.target, link.rel]).toEqual(["_blank", "noopener noreferrer"]);
    }
  });

  it("**草の下に活動の概観を置く** (ADR-0021)。大きさを先に確保し、遅延読み込みで Referer を送らない", () => {
    const t = setup();
    t.open(graphs([{ label: "alpha", sent: true }]));

    const images = [...(t.find()?.querySelectorAll<HTMLImageElement>(OVERVIEW) ?? [])];
    expect(images.map((img) => img.getAttribute("src"))).toEqual([
      overviewOf("aa"),
      overviewOf("b0"),
    ]);
    for (const img of images) {
      expect([img.width, img.height]).toEqual([OVERVIEW_WIDTH, OVERVIEW_HEIGHT]);
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    }
    // 同じ囲みの中で、草の後・コピーの前
    const block = t.sections().find((node) => node.style.border !== "");
    const order = [...(block?.querySelectorAll(`${GRASS}, ${OVERVIEW}, button`) ?? [])].map(
      (node) => (node.tagName === "BUTTON" ? "button" : (node as HTMLImageElement).alt),
    );
    expect(order).toEqual([
      `${TOTAL_LABEL} の草`,
      `${TOTAL_LABEL} の活動の概観`,
      "button",
      "button",
      "button",
    ]);
  });

  it("**概観が読めなければ何も出さない** (理由は草の側で言う)", () => {
    const t = setup();
    t.open(graphs([]));

    t.find()?.querySelector<HTMLImageElement>(OVERVIEW)?.dispatchEvent(new Event("error"));

    expect(t.find()?.querySelectorAll<HTMLImageElement>(OVERVIEW)).toHaveLength(0);
    expect(t.find()?.querySelectorAll<HTMLImageElement>(GRASS)).toHaveLength(1);
    expect(t.find()?.textContent).not.toContain("表示できませんでした");
  });

  it("**読めなかった画像は文言に置き換える**", () => {
    const t = setup();
    t.open(graphs([]));

    t.find()?.querySelector<HTMLImageElement>(GRASS)?.dispatchEvent(new Event("error"));

    expect(t.find()?.querySelectorAll<HTMLImageElement>(GRASS)).toHaveLength(0);
    expect(t.find()?.textContent).toContain("草を表示できませんでした");
  });

  it("**このブラウザから送れていない草も、最初から読む** (2026-09-24。押す手間をなくした)", () => {
    const t = setup();
    t.open(graphs([{ label: "beta", sent: false }], false));

    expect(
      [...(t.find()?.querySelectorAll<HTMLImageElement>(GRASS) ?? [])].map((i) =>
        i.getAttribute("src"),
      ),
    ).toEqual([url("aa"), url("b0")]);
    expect(t.buttons("表示してみる")).toEqual([]);
  });

  it("**送れていない草が読めなかったときは、まだ送っていないと言う** (サーバの不調と取り違えない)", () => {
    const t = setup();
    t.open(graphs([{ label: "beta", sent: false }]));
    const [total, beta] = t.sections().filter((s) => s.firstElementChild?.tagName === "H4");

    for (const img of t.find()?.querySelectorAll<HTMLImageElement>(GRASS) ?? []) {
      img.dispatchEvent(new Event("error"));
    }

    expect(total?.textContent).toContain("草を表示できませんでした");
    expect(beta?.textContent).toContain("このブラウザからはまだ送っていません");
    expect(beta?.textContent).not.toContain("草を表示できませんでした");
  });

  it(`**プロジェクト別は ${INITIAL_PROJECT_GRAPHS} 件まで出し、残りは押すと出す**`, () => {
    const t = setup();
    const projects = Array.from({ length: INITIAL_PROJECT_GRAPHS + 2 }, (_, i) => ({
      label: `p${i}`,
      sent: true,
    }));
    t.open(graphs(projects));

    expect(t.find()?.querySelectorAll<HTMLImageElement>(GRASS)).toHaveLength(
      1 + INITIAL_PROJECT_GRAPHS,
    );

    t.buttons("ほか 2 件を表示")[0]?.click();

    expect(t.find()?.querySelectorAll<HTMLImageElement>(GRASS)).toHaveLength(
      1 + INITIAL_PROJECT_GRAPHS + 2,
    );
    expect(t.buttons("ほか 2 件を表示")).toHaveLength(0);
    expect(
      [...(t.sections()[0]?.querySelectorAll(CARD_TITLE) ?? [])].map((h) => h.textContent),
    ).toEqual([TOTAL_LABEL, ...projects.map((p) => p.label)]);
  });

  it("記録したプロジェクトが無ければそう書く", () => {
    const t = setup();
    t.open(graphs([]));

    expect(t.find()?.textContent).toContain("直近 30 日に記録したプロジェクトはまだありません");
  });

  it("**コピーは押した処理の中で同期に呼び**、できたらそう書く", async () => {
    const t = setup();
    t.open(graphs([{ label: "alpha", sent: true }]));

    t.find()?.querySelector<HTMLButtonElement>('[aria-label="alpha の草の URL をコピー"]')?.click();

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

  it("**開き直すと前のダイアログを消す。** 外側のクリック・Esc で消える", () => {
    const t = setup();
    t.open(graphs([]));
    t.open(message("2 回目"));

    expect(document.querySelectorAll("dialog")).toHaveLength(1);
    expect(t.find()?.textContent).toContain("2 回目");

    clickAt(t.find(), OUTSIDE, OUTSIDE);
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
    for (const img of t.find()?.querySelectorAll<HTMLImageElement>(GRASS) ?? []) {
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
      graphs([], true, {
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
      graphs([], true, {
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
    t.open(graphs([{ label: "alpha", sent: true }], true, { lines: [], canSend: true }));
    const created: HTMLImageElement[] = [];
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const node = original(tag);
      if (tag === "img") created.push(node as HTMLImageElement);
      return node;
    });

    t.buttons(SEND_NOW_LABEL)[0]?.click();
    await settle();

    // 表示中の草 2 枚と概観 2 枚を、キャッシュを外すクエリ付きで取り直す
    expect(created.map((img) => img.getAttribute("src"))).toEqual([
      expect.stringMatching(/\/aa0+\.svg\?r=\d+$/),
      expect.stringMatching(/\/aa0+\/overview\.svg\?r=\d+$/),
      expect.stringMatching(/\/b00+\.svg\?r=\d+$/),
      expect.stringMatching(/\/b00+\/overview\.svg\?r=\d+$/),
    ]);
    // 読めるまでは古い絵のまま
    expect(
      [...(t.find()?.querySelectorAll<HTMLImageElement>(GRASS) ?? [])].map((i) =>
        i.getAttribute("src"),
      ),
    ).toEqual([url("aa"), url("b0")]);

    created[0]?.dispatchEvent(new Event("load"));
    expect(t.find()?.querySelector<HTMLImageElement>(GRASS)?.getAttribute("src")).toMatch(
      /\?r=\d+$/,
    );
  });

  it("**すでにクエリのある URL は `&` で継ぐ** (プロジェクト名の `?l=` を壊さない。Issue #119)", async () => {
    const t = setup(undefined, () =>
      Promise.resolve({ text: "送りました。", view: SYNC, refresh: true }),
    );
    const labelled = `${url("aa")}?l=villagepump`;
    t.open({
      kind: "graphs",
      total: {
        label: "すべて",
        url: labelled,
        overviewUrl: overviewOf("aa"),
        dataUrl: dataOf("aa"),
        sent: true,
      },
      projects: [],
      sync: { lines: [], canSend: true },
    });
    const created: HTMLImageElement[] = [];
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const node = original(tag);
      if (tag === "img") created.push(node as HTMLImageElement);
      return node;
    });

    t.buttons(SEND_NOW_LABEL)[0]?.click();
    await settle();

    expect(created.map((img) => img.getAttribute("src"))).toEqual([
      expect.stringMatching(/\?l=villagepump&r=\d+$/),
      expect.stringMatching(/\/overview\.svg\?r=\d+$/),
    ]);
  });

  it("**取り直しのクエリはコピーする URL に混ぜない** (他人に渡すもの)", async () => {
    const t = setup(undefined, () =>
      Promise.resolve({ text: "送りました。", view: SYNC, refresh: true }),
    );
    t.open(graphs([], true, { lines: [], canSend: true }));

    t.buttons(SEND_NOW_LABEL)[0]?.click();
    await settle();
    t.buttons("URL をコピー")[0]?.click();
    await settle();

    expect(t.copied).toEqual([url("aa")]);
  });
});
