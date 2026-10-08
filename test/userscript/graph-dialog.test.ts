import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CARD_FORM, CELLS, GRASS_SIZES, SPANS } from "../../src/shared/grass.ts";
import { GUIDE_HEIGHTS, GUIDE_WIDTH } from "../../src/shared/guide.ts";
import {
  BUTTON_CLASS,
  DIALOG_ATTRIBUTE,
  DIALOG_BORDER,
  DIALOG_PADDING,
} from "../../src/userscript/dialog.ts";
import {
  CELL_LABELS,
  COPIED_FEEDBACK_MS,
  createGraphDialog,
  DIALOG_MAX_WIDTH,
  FIRST_YEAR,
  figureSize,
  type SendNowResult,
  SPAN_LABELS,
} from "../../src/userscript/graph-dialog.ts";
import { MENU_TITLE, SETTINGS_LABEL } from "../../src/userscript/settings.ts";
import {
  INITIAL_PROJECT_GRAPHS,
  type IntegratedView,
  SEND_NOW_LABEL,
  type SyncView,
  TOTAL_LABEL,
} from "../../src/userscript/viewer.ts";
import { WORKER_ORIGIN } from "../../src/userscript/worker-origin.ts";

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

const id = (name: string) => name.padEnd(32, "0");
/** 既定の形 (直近 26 週 × 時間帯) の図の URL。`query` は形や名前のクエリ (`?l=p0` など) */
const cardOf = (name: string, query = "") =>
  `https://grass.soui.dev/v1/g/${id(name)}/card.svg${query}`;
/** 1 年 × 1 日の図の URL (`{publicId}.svg`。ADR-0026 決定 6) */
const graphOf = (name: string, query = "") => `https://grass.soui.dev/v1/g/${id(name)}.svg${query}`;
/** 囲みの見出し (説明の `<details>` の中の見出しと分ける) */
const CARD_TITLE = "section > h4";
/** 囲みの図 (説明の図と分ける) */
const FIGURE = 'img[alt$="の図"]';
/** 貼る行のボタンの文言。名乗り (`aria-label`) は「Cosense に貼る行をコピー」 */
const PASTE_LINE = "貼る行をコピー";
const dataOf = (name: string) => `https://grass.soui.dev/v1/g/${id(name)}/${"f".repeat(32)}.json`;

const SYNC: SyncView = { lines: ["このブラウザの記録は送信済みです。"], canSend: false };

/** 合算 (`aa`) とプロジェクト別 (`b0`, `b1`, …。プロジェクト名は `p0`, `p1`, …) */
function graphs(
  projects: { label: string; sent: boolean }[],
  totalSent = true,
  sync: SyncView = SYNC,
): IntegratedView {
  return {
    kind: "graphs",
    total: {
      label: TOTAL_LABEL,
      publicId: id("aa"),
      names: {},
      dataUrl: dataOf("aa"),
      sent: totalSent,
    },
    projects: projects.map((p, i) => ({
      ...p,
      publicId: id(`b${i}`),
      names: { project: `p${i}` },
      dataUrl: dataOf(`b${i}`),
    })),
    sync,
  };
}

/** 表示中の図の src */
const srcsOf = (dialog: HTMLDialogElement | null) =>
  [...(dialog?.querySelectorAll<HTMLImageElement>(FIGURE) ?? [])].map((img) =>
    img.getAttribute("src"),
  );

/** これから作られる `<img>` を集める (読み直しと取り直しを見る) */
function captureImages(): HTMLImageElement[] {
  const created: HTMLImageElement[] = [];
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
    const node = original(tag);
    if (tag === "img") created.push(node as HTMLImageElement);
    return node;
  });
  return created;
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
  now?: () => number,
) {
  const copied: string[] = [];
  const settings = { count: 0 };
  const sent = { count: 0 };
  const dialog = createGraphDialog(document, {
    writeText: (text) => {
      copied.push(text);
      return writeText(text);
    },
    ...(now ? { now } : {}),
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
    expect(node?.querySelectorAll<HTMLImageElement>(FIGURE)).toHaveLength(0);
  });

  it("**図は img で出す。** 大きさは選んでいる形の外寸・alt・遅延読み込み・Referer を送らない指定が付き、属性のハンドラは無い", () => {
    const t = setup();

    t.open(graphs([{ label: "alpha", sent: true }]));

    const images = [...(t.find()?.querySelectorAll<HTMLImageElement>(FIGURE) ?? [])];
    // 既定の形はカード (直近 26 週 × 時間帯)。プロジェクト別には名前が付く
    expect(srcsOf(t.find())).toEqual([cardOf("aa"), cardOf("b0", "?l=p0")]);
    const { width, height } = GRASS_SIZES.half.slot;
    for (const img of images) {
      expect([img.width, img.height]).toEqual([width, height]);
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect([img.style.maxWidth, img.style.height]).toEqual(["100%", "auto"]);
    }
    expect(images.map((img) => img.alt)).toEqual([`${TOTAL_LABEL} の図`, "alpha の図"]);
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
      // 見出しと図が 1 つずつ、コピーが 3 つ (図の URL・貼る行・日ごとの数値) と JSON を開くリンクが同じ囲みの中にある
      expect(block.querySelectorAll(CARD_TITLE)).toHaveLength(1);
      expect(block.querySelectorAll<HTMLImageElement>(FIGURE)).toHaveLength(1);
      expect([...block.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
        "URL をコピー",
        PASTE_LINE,
        "URL をコピー",
      ]);
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
      `${TOTAL_LABEL} の図の URL をコピー`,
      `${TOTAL_LABEL} の日ごとの数値の URL をコピー`,
      "project-a の図の URL をコピー",
      "project-a の日ごとの数値の URL をコピー",
    ]);
  });

  it("**URL のコピーは図と日ごとの数値の URL を書き、JSON は別のタブで Referer を送らずに開く** (#164)", async () => {
    const t = setup();
    t.open(graphs([]));

    for (const copy of t.buttons("URL をコピー")) {
      copy.click();
    }
    await settle();
    expect(t.copied).toEqual([cardOf("aa"), dataOf("aa")]);

    const open = t
      .find()
      ?.querySelector<HTMLAnchorElement>('a[aria-label$="の日ごとの数値を開く"]');
    expect(open?.href).toBe(dataOf("aa"));
    expect(open?.target).toBe("_blank");
    expect(open?.rel).toBe("noopener noreferrer");
    // 渡すと内訳まで読めることを添える
    expect(t.find()?.textContent).toContain("日ごとの内訳まで読めます");
  });

  it("**貼る行のコピーは、その図と同じ囲みに置き、対象を名乗る**", () => {
    const t = setup();
    t.open(graphs([{ label: "alpha", sent: true }]));

    const blocks = t.sections().filter((node) => node.style.border !== "");
    expect(
      t
        .buttons(PASTE_LINE)
        .map((b) => [
          blocks.indexOf(b.closest("section") as HTMLElement),
          b.getAttribute("aria-label"),
        ]),
    ).toEqual([
      [0, `${TOTAL_LABEL} の図の Cosense に貼る行をコピー`],
      [1, "alpha の図の Cosense に貼る行をコピー"],
    ]);
  });

  it("**「Cosense に貼る行をコピー」は選んでいる形の図の画像の行を書く** (リンク先は付けない。ADR-0025 決定 6 の改訂)", async () => {
    const t = setup();
    t.open(graphs([{ label: "alpha", sent: true }]));

    for (const copy of t.buttons(PASTE_LINE)) {
      copy.click();
    }
    await settle();

    expect(t.copied).toEqual([`[${cardOf("aa")}]`, `[${cardOf("b0", "?l=p0")}]`]);
  });

  it("**行をコピーできなければ、選べる欄に行を出す**", async () => {
    const t = setup(() => Promise.reject(new Error("denied")));
    t.open(graphs([]));

    t.buttons(PASTE_LINE)[0]?.click();
    await settle();

    const field = t.find()?.querySelector<HTMLInputElement>("input[type=text]");
    expect(field?.value).toBe(`[${cardOf("aa")}]`);
    expect(field?.getAttribute("aria-label")).toBe(`${TOTAL_LABEL} の図の Cosense に貼る行`);
  });

  it("**説明に、カードの行を自分のページに自動で貼ること・止め方を書く** (ADR-0025 決定 4)", () => {
    const t = setup();
    t.open(graphs([]));

    const text = t.find()?.querySelector("details")?.textContent ?? "";
    expect(text).toContain("自動で貼ります");
    expect(text).toContain("貼り直します");
    expect(text).toContain("読み込みの 1 行を外して");
  });

  it("**図の右にコピーの格子を並べ、入らなければ (1 年の図・狭い画面) 下へ折り返す** (ADR-0026)", () => {
    const t = setup();
    t.open(graphs([]));

    const block = t.sections().find((node) => node.style.border !== "");
    const frame = block?.querySelector(FIGURE)?.parentElement;
    const row = frame?.parentElement;
    expect(row?.parentElement).toBe(block);
    expect(row?.style.display).toBe("flex");
    expect(row?.style.flexWrap).toBe("wrap");
    expect(row?.firstElementChild).toBe(frame);
    const grid = row?.children[1] as HTMLElement | undefined;
    expect(grid?.style.display).toBe("grid");
    expect([...(grid?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
      "URL をコピー",
      PASTE_LINE,
      "URL をコピー",
    ]);
    // 半年の図 (幅 500) の横には格子が並ぶ (囲みの内側は 1 年の図の幅 775)
    expect(
      GRASS_SIZES.half.slot.width + 16 + Number.parseInt(grid?.style.flexBasis ?? "0", 10),
    ).toBeLessThanOrEqual(GRASS_SIZES.year.slot.width);
  });

  it("**図の寸法は外寸の表 (`GRASS_SIZES`) どおり。年を選んだら 1 年の形** (縦横比を崩さない。#156・#202)", () => {
    for (const span of SPANS) {
      for (const cell of CELLS) {
        expect(figureSize({ span, cell })).toEqual(GRASS_SIZES[span][cell]);
      }
    }
    expect(figureSize({ span: "half", cell: "day", year: 2026 })).toEqual(GRASS_SIZES.year.day);
  });

  it("**ダイアログの幅の上限は、囲みの幅に余白と枠を足した外寸** (border-box。足し忘れると Cosense で縦に崩れた。2026-10-07)", () => {
    const t = setup();
    t.open(graphs([]));

    // いちばん広い図 (1 年、幅 775) が縮まずに入る
    const block = GRASS_SIZES.year.day.width + 2 * (12 + 1);
    expect(DIALOG_MAX_WIDTH).toBe(block + 2 * (DIALOG_PADDING + DIALOG_BORDER));
    // 画面側の上限 (calc) は jsdom が書き換えるので、外寸の側だけ見る
    expect(t.find()?.style.maxWidth).toMatch(new RegExp(`^min\\(${DIALOG_MAX_WIDTH}px, `));
  });

  it("**囲みより図が広い画面 (スマホ) では、枠ごと縦横比を保って縮める**", () => {
    const t = setup();
    t.open(graphs([]));

    const img = t.find()?.querySelector<HTMLImageElement>(FIGURE);
    expect([img?.style.maxWidth, img?.style.height]).toEqual(["100%", "auto"]);
    expect(img?.parentElement?.style.flexShrink).toBe("1");
    expect(img?.parentElement?.style.minWidth).toBe("0px");
  });

  it("**日ごとの数値を渡すと何が読めるかを、囲みの下端に添える** (ADR-0020 の改訂)", () => {
    const t = setup();
    t.open(graphs([{ label: "alpha", sent: true }]));

    const blocks = t.sections().filter((node) => node.style.border !== "");
    for (const block of blocks) {
      expect(block.lastElementChild?.textContent).toContain("日ごとの内訳まで読めます");
    }
  });

  it("**何をどう数えて描いているかを、畳んだ説明で添える** (#164)", () => {
    const t = setup();
    t.open(graphs([]));

    const details = t.find()?.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toContain("図の見方");
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
      // 時間帯の区切り (ADR-0024 決定 1)
      "9〜13 時",
      "18 時〜翌 9 時",
    ]) {
      expect(text).toContain(phrase);
    }
    // 理由の文言だけのときも出す
    const u = setup();
    u.open(message("この端末は未登録"));
    expect(u.find()?.querySelector("details")).not.toBeNull();
  });

  it("**説明の 3 節の先頭に、Worker が描いた例の図を添える** (#182)", () => {
    const t = setup();
    t.open(graphs([]));

    const details = t.find()?.querySelector("details");
    const figures = [...(details?.querySelectorAll("img") ?? [])];
    expect(figures.map((img) => img.src)).toEqual([
      `${WORKER_ORIGIN}/v1/guide/minutes.svg?v=2`,
      `${WORKER_ORIGIN}/v1/guide/grass.svg?v=2`,
      `${WORKER_ORIGIN}/v1/guide/overview.svg?v=2`,
    ]);
    for (const [img, height] of figures.map(
      (img, i) => [img, Object.values(GUIDE_HEIGHTS)[i]] as const,
    )) {
      // 図が読めないときにも要点が伝わる
      expect(img.alt.length).toBeGreaterThan(20);
      // 寸法を先に確保し、狭い画面では縦横比を保って縮む
      expect(img.width).toBe(GUIDE_WIDTH);
      expect(img.height).toBe(height);
      expect(img.style.maxWidth).toBe("100%");
      expect(img.style.height).toBe("auto");
      // 畳んだ説明を開くまで取りに行かない
      expect(img.loading).toBe("lazy");
      // 見出しの直後に置く
      expect(img.previousElementSibling?.tagName).toBe("H4");
    }
  });

  it("**説明の見出しは、開けることが分かる帯にする** (#170)", () => {
    const t = setup();
    t.open(graphs([]));
    const details = t.find()?.querySelector("details");
    const summary = details?.querySelector("summary");
    // 既定の三角を消し、背景でボタンらしく見せる
    expect(summary?.style.listStyle).toBe("none");
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

  it("**開いた範囲が分かるよう、枠は見出しと本文をまとめて囲む** (#173)", () => {
    const t = setup();
    t.open(graphs([]));
    const details = t.find()?.querySelector("details");
    const summary = details?.querySelector("summary");
    if (details === null || details === undefined || summary === null || summary === undefined) {
      throw new Error("details が無い");
    }
    // 枠は見出しでなく details 全体
    expect(details.style.border).not.toBe("");
    expect(summary.style.border).toBe("");
    // 閉じているときは区切り線を引かない (枠と重なって二重線になる)
    expect(summary.style.borderBottom).toBe("");

    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    expect(summary.style.borderBottom).not.toBe("");

    details.open = false;
    details.dispatchEvent(new Event("toggle"));
    expect(summary.style.borderBottom).toBe("");
  });

  it("説明の線の読み方は、割合で取り合い、% は分の割合であることを書く。平方根 (レーダー) の話は消した (ADR-0026)", () => {
    const t = setup();
    t.open(graphs([]));
    const text = t.find()?.querySelector("details")?.textContent ?? "";
    expect(text).toContain("割合で取り合い");
    expect(text).toContain("% は分の割合");
    expect(text).not.toContain("平方根");
    expect(text).not.toContain("概観");
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

  it("**読めなかった画像は文言に置き換える**", () => {
    const t = setup();
    t.open(graphs([]));

    t.find()?.querySelector<HTMLImageElement>(FIGURE)?.dispatchEvent(new Event("error"));

    expect(t.find()?.querySelectorAll<HTMLImageElement>(FIGURE)).toHaveLength(0);
    expect(t.find()?.textContent).toContain("図を表示できませんでした");
  });

  it("**このブラウザから送れていない草も、最初から読む** (2026-09-24。押す手間をなくした)", () => {
    const t = setup();
    t.open(graphs([{ label: "beta", sent: false }], false));

    expect(srcsOf(t.find())).toEqual([cardOf("aa"), cardOf("b0", "?l=p0")]);
    expect(t.buttons("表示してみる")).toEqual([]);
  });

  it("**送れていない草が読めなかったときは、まだ送っていないと言う** (サーバの不調と取り違えない)", () => {
    const t = setup();
    t.open(graphs([{ label: "beta", sent: false }]));
    const [total, beta] = t.sections().filter((s) => s.firstElementChild?.tagName === "H4");

    for (const img of t.find()?.querySelectorAll<HTMLImageElement>(FIGURE) ?? []) {
      img.dispatchEvent(new Event("error"));
    }

    expect(total?.textContent).toContain("図を表示できませんでした");
    expect(beta?.textContent).toContain("このブラウザからはまだ送っていません");
    expect(beta?.textContent).not.toContain("図を表示できませんでした");
  });

  it(`**プロジェクト別は ${INITIAL_PROJECT_GRAPHS} 件まで出し、残りは押すと出す**`, () => {
    const t = setup();
    const projects = Array.from({ length: INITIAL_PROJECT_GRAPHS + 2 }, (_, i) => ({
      label: `p${i}`,
      sent: true,
    }));
    t.open(graphs(projects));

    expect(t.find()?.querySelectorAll<HTMLImageElement>(FIGURE)).toHaveLength(
      1 + INITIAL_PROJECT_GRAPHS,
    );

    t.buttons("ほか 2 件を表示")[0]?.click();

    expect(t.find()?.querySelectorAll<HTMLImageElement>(FIGURE)).toHaveLength(
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

    t.find()?.querySelector<HTMLButtonElement>('[aria-label="alpha の図の URL をコピー"]')?.click();

    // await の前に呼ばれている
    expect(t.copied).toEqual([cardOf("b0", "?l=p0")]);
    await settle();
    expect(t.find()?.textContent).toContain("コピーしました");
  });

  it("**ダイアログは Cosense の見た目の印を持つ** (#175)", () => {
    const t = setup();
    t.open(graphs([]));
    expect(t.find()?.hasAttribute(DIALOG_ATTRIBUTE)).toBe(true);
    expect(t.find()?.querySelectorAll("style")).toHaveLength(1);
  });

  it("**コピーのボタンはアイコン付きで、できたら 2 秒だけチェックと緑にして戻す** (#175)", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.open(graphs([]));
      const copy = t.buttons("URL をコピー")[0];
      const iconOf = () => copy?.querySelector("svg")?.getAttribute("data-icon");
      expect(iconOf()).toBe("copy");
      expect(copy?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

      copy?.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(iconOf()).toBe("check");
      expect(copy?.style.color).not.toBe("");
      // 文言と aria-label は変えない (読み上げと、文言でボタンを探すテストのため)
      expect(copy?.textContent).toBe("URL をコピー");
      const status = copy?.parentElement?.querySelector('[role="status"]');
      expect(status?.textContent).toBe("コピーしました");

      await vi.advanceTimersByTimeAsync(COPIED_FEEDBACK_MS);
      expect(iconOf()).toBe("copy");
      expect(copy?.style.color).toBe("");
      expect(status?.textContent).toBe("");
      expect(copy?.querySelectorAll("svg")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("JSON の「開く」は、リンクのままボタンの見た目にする (#175)", () => {
    const t = setup();
    t.open(graphs([]));
    const open = t.find()?.querySelector<HTMLAnchorElement>("a[target=_blank]." + BUTTON_CLASS);
    expect(open?.textContent).toBe("開く");
    expect(open?.querySelector("svg")?.getAttribute("data-icon")).toBe("external");
  });

  it("**コピーできなければ、選べる欄に URL を出す** (押し直しても欄は 1 つ)", async () => {
    const t = setup(() => Promise.reject(new Error("denied")));
    t.open(graphs([]));

    t.buttons("URL をコピー")[0]?.click();
    await settle();
    t.buttons("URL をコピー")[0]?.click();
    await settle();

    const fields = [...(t.find()?.querySelectorAll<HTMLInputElement>("input[type=text]") ?? [])];
    expect(fields).toHaveLength(1);
    expect(fields[0]?.readOnly).toBe(true);
    expect(fields[0]?.value).toBe(cardOf("aa"));
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

  it("**図の URL をコンソールに出さない**", async () => {
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
    for (const img of t.find()?.querySelectorAll<HTMLImageElement>(FIGURE) ?? []) {
      img.dispatchEvent(new Event("error"));
    }
    await settle();

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("**同期の状態を合算の図の直後に出し、送るものが無ければボタンを無効にする** (Issue #102)", () => {
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

  it("**送れたら表示中の図を取り直す。** 新しい絵が読めてから差し替える (失敗しても古い絵を残す)", async () => {
    const t = setup(undefined, () =>
      Promise.resolve({ text: "送りました。", view: SYNC, refresh: true }),
    );
    t.open(graphs([{ label: "alpha", sent: true }], true, { lines: [], canSend: true }));
    const created = captureImages();

    t.buttons(SEND_NOW_LABEL)[0]?.click();
    await settle();

    // 表示中の図を 1 枚ずつ、キャッシュを外すクエリ付きで取り直す。**すでにクエリ (`?l=`) があれば `&` で継ぐ** (Issue #119)
    expect(created.map((img) => img.getAttribute("src"))).toEqual([
      expect.stringMatching(/\/aa0+\/card\.svg\?r=\d+$/),
      expect.stringMatching(/\/b00+\/card\.svg\?l=p0&r=\d+$/),
    ]);
    // 読めるまでは古い絵のまま
    expect(srcsOf(t.find())).toEqual([cardOf("aa"), cardOf("b0", "?l=p0")]);

    created[0]?.dispatchEvent(new Event("load"));
    expect(t.find()?.querySelector<HTMLImageElement>(FIGURE)?.getAttribute("src")).toMatch(
      /\?r=\d+$/,
    );
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

    expect(t.copied).toEqual([cardOf("aa")]);
  });

  describe("図の形の切り替え (期間とマス。ADR-0026・#177)", () => {
    /** 2027 年 3 月 1 日 (ローカル時刻) */
    const IN_2027 = () => new Date(2027, 2, 1).getTime();
    const choosePeriod = (t: ReturnType<typeof setup>, value: string) => {
      const select = t.find()?.querySelector("select");
      if (!select) {
        throw new Error("期間の選択が無い");
      }
      select.value = value;
      select.dispatchEvent(new Event("change"));
    };
    const chooseCell = (t: ReturnType<typeof setup>, value: "slot" | "day") => {
      const radio = t.find()?.querySelector<HTMLInputElement>(`input[type=radio][value=${value}]`);
      if (!radio) {
        throw new Error("マスの選択が無い");
      }
      radio.checked = true;
      radio.dispatchEvent(new Event("change"));
    };
    const loadAll = (images: readonly HTMLImageElement[]) => {
      for (const img of images) {
        img.dispatchEvent(new Event("load"));
      }
    };

    it("**期間は「直近 26 週」「直近 1 年」と、去年から 2026 年までの各年。今年は並べない** (直近 1 年と同じ絵になる)", () => {
      const t = setup(undefined, undefined, () => new Date(2028, 0, 5).getTime());
      t.open(graphs([]));
      const options = [...(t.find()?.querySelectorAll("option") ?? [])];
      expect(options.map((o) => [o.value, o.textContent])).toEqual([
        ["half", SPAN_LABELS.half],
        ["year", SPAN_LABELS.year],
        ["2027", "2027 年"],
        ["2026", "2026 年"],
      ]);
      expect(FIRST_YEAR).toBe(2026);
      // 既定はカードの形
      expect(t.find()?.querySelector("select")?.value).toBe(CARD_FORM.span);
      expect(t.find()?.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value).toBe(
        CARD_FORM.cell,
      );
      // 理由の文言だけのとき (図が無い) は出さない
      document.body.replaceChildren();
      const u = setup(undefined, undefined, IN_2027);
      u.open(message("この端末は未登録"));
      expect(u.find()?.querySelector("select")).toBeNull();
    });

    it("**過去の年が無いあいだ (2026 年) も、半年と 1 年は選べる**", () => {
      const t = setup(undefined, undefined, () => new Date(2026, 11, 31).getTime());
      t.open(graphs([]));
      expect([...(t.find()?.querySelectorAll("option") ?? [])].map((o) => o.value)).toEqual([
        "half",
        "year",
      ]);
    });

    it("**マスは「時間帯」と「1 日」の 2 択で、並べて見える radio にする**", () => {
      const t = setup();
      t.open(graphs([]));
      const group = t.find()?.querySelector('[role="radiogroup"]');
      expect(group?.getAttribute("aria-label")).toBe("マス");
      expect(
        [...(group?.querySelectorAll("label") ?? [])].map((label) => [
          label.querySelector("input")?.value,
          label.textContent,
        ]),
      ).toEqual([
        ["slot", CELL_LABELS.slot],
        ["day", CELL_LABELS.day],
      ]);
    });

    it("**期間を替えると、すべての囲みの図をその形の URL と寸法で読み直し、読めてから差し替える**", () => {
      const t = setup();
      t.open(graphs([{ label: "alpha", sent: true }]));
      const created = captureImages();

      choosePeriod(t, "year");

      expect(created.map((img) => img.getAttribute("src"))).toEqual([
        cardOf("aa", "?span=year"),
        cardOf("b0", "?span=year&l=p0"),
      ]);
      expect(created.map((img) => [img.width, img.height])).toEqual([
        [GRASS_SIZES.year.slot.width, GRASS_SIZES.year.slot.height],
        [GRASS_SIZES.year.slot.width, GRASS_SIZES.year.slot.height],
      ]);
      // 読めるまでは前の絵
      expect(srcsOf(t.find())).toEqual([cardOf("aa"), cardOf("b0", "?l=p0")]);
      loadAll(created);
      expect(srcsOf(t.find())).toEqual([
        cardOf("aa", "?span=year"),
        cardOf("b0", "?span=year&l=p0"),
      ]);
    });

    it("**1 年 × 1 日を選ぶと `{publicId}.svg` を使い、クエリを付けない** (貼ってある草と同じ URL)", () => {
      const t = setup();
      t.open(graphs([{ label: "alpha", sent: true }]));
      const created = captureImages();

      chooseCell(t, "day");
      expect(created.map((img) => img.getAttribute("src"))).toEqual([
        cardOf("aa", "?cell=day"),
        cardOf("b0", "?cell=day&l=p0"),
      ]);
      choosePeriod(t, "year");
      expect(created.slice(2).map((img) => img.getAttribute("src"))).toEqual([
        graphOf("aa"),
        graphOf("b0", "?l=p0"),
      ]);
      expect([created[2]?.width, created[2]?.height]).toEqual([
        GRASS_SIZES.year.day.width,
        GRASS_SIZES.year.day.height,
      ]);
    });

    it("**年を選ぶと 1 年の形で `?year=` を付ける** (期間の `span` は付けない)", () => {
      const t = setup(undefined, undefined, IN_2027);
      t.open(graphs([]));
      const created = captureImages();

      choosePeriod(t, "2026");
      chooseCell(t, "day");

      expect(created.map((img) => img.getAttribute("src"))).toEqual([
        cardOf("aa", "?year=2026"),
        graphOf("aa", "?year=2026"),
      ]);
    });

    it("**続けて替えたら、最後に選んだ形の絵だけを出す** (先に頼んだ古い形の読み込みが後から終わっても差し替えない)", () => {
      const t = setup();
      t.open(graphs([]));
      const created = captureImages();

      choosePeriod(t, "year");
      chooseCell(t, "day");
      const [stale, latest] = created;
      // 新しい形が先に読め、古い形が後から読めた (失敗した) とき
      latest?.dispatchEvent(new Event("load"));
      stale?.dispatchEvent(new Event("load"));
      expect(srcsOf(t.find())).toEqual([graphOf("aa")]);
      stale?.dispatchEvent(new Event("error"));
      expect(srcsOf(t.find())).toEqual([graphOf("aa")]);
      expect(t.find()?.textContent).not.toContain("図を表示できませんでした");
    });

    it("**形を替えた後に、最初に出した図の失敗が届いても文言で上書きしない**", () => {
      const t = setup();
      t.open(graphs([]));
      const first = t.find()?.querySelector<HTMLImageElement>(FIGURE);
      const created = captureImages();

      choosePeriod(t, "year");
      created[0]?.dispatchEvent(new Event("load"));
      first?.dispatchEvent(new Event("error"));

      expect(srcsOf(t.find())).toEqual([cardOf("aa", "?span=year")]);
      expect(t.find()?.textContent).not.toContain("図を表示できませんでした");
    });

    it("**読み直せなければ、前の形の絵を残さず文言に替える** (別の形の絵と取り違えない)", () => {
      const t = setup();
      t.open(graphs([]));
      const created = captureImages();

      choosePeriod(t, "year");
      created[0]?.dispatchEvent(new Event("error"));

      expect(t.find()?.querySelector(FIGURE)).toBeNull();
      expect(t.find()?.textContent).toContain("図を表示できませんでした");
    });

    it("**コピーする図の URL と貼る行も選んでいる形になり、`l` は残る。JSON は全期間のまま**", async () => {
      const t = setup(undefined, undefined, IN_2027);
      t.open(graphs([{ label: "alpha", sent: true }]));

      choosePeriod(t, "2026");
      for (const copy of t.find()?.querySelectorAll<HTMLButtonElement>("section section button") ??
        []) {
        if (copy.closest("section")?.querySelector("h4")?.textContent === "alpha") {
          copy.click();
        }
      }
      await settle();
      expect(t.copied).toEqual([
        cardOf("b0", "?year=2026&l=p0"),
        `[${cardOf("b0", "?year=2026&l=p0")}]`,
        dataOf("b0"),
      ]);

      // 直近 26 週に戻すと、形のクエリを付けない
      choosePeriod(t, "half");
      t.buttons("URL をコピー")[0]?.click();
      expect(t.copied.at(-1)).toBe(cardOf("aa"));
    });

    it("**送った後の取り直しも、選んでいる形の URL で行う**。開き直すと既定の形に戻る", async () => {
      const t = setup(
        undefined,
        () => Promise.resolve({ text: "送りました。", view: SYNC, refresh: true }),
        IN_2027,
      );
      t.open(graphs([], true, { lines: [], canSend: true }));
      choosePeriod(t, "2026");
      const created = captureImages();

      t.buttons(SEND_NOW_LABEL)[0]?.click();
      await settle();
      expect(created.map((img) => img.getAttribute("src"))).toEqual([
        expect.stringMatching(/\/aa0+\/card\.svg\?year=2026&r=\d+$/),
      ]);

      vi.restoreAllMocks();
      t.open(graphs([]));
      expect(t.find()?.querySelector("select")?.value).toBe("half");
      expect(t.find()?.querySelector<HTMLInputElement>("input[type=radio]:checked")?.value).toBe(
        "slot",
      );
      expect(srcsOf(t.find())).toEqual([cardOf("aa")]);
    });
  });
});
