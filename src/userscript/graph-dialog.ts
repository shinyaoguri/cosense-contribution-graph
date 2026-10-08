/**
 * 草のダイアログ (design §9「表示」、段階 8、Issue #73)。何を並べるかは `viewer.ts` が決める。
 *
 * - **ページに挿さずダイアログにする。** Cosense の遷移で消えないので、再マウントが要らない (ADR-0003 の改訂)
 * - **草は常にライトで出す。** 素の `<dialog>` は Cosense のどのテーマでも白地に黒 (research §3 の 2026-09-15 の実測)。
 *   枠とボタンは Cosense の見た目に合わせる (`dialog.ts` の `styleDialog`、#175)
 * - **出すのは Worker が作った共有 SVG の `<img>` だけ** (ADR-0019、Issue #109)。ここは草を描かない。
 *   ~~このブラウザから送れていないものは、押されるまで読まない~~ **2026-09-24 に最初から読むよう改めた**
 *   (押す手間の方が煩わしかった)。読めなかったときの文言だけを、送れたかどうかで言い分ける
 * - **閉じるのは外側のクリックと Esc** (2026-09-24。「閉じる」ボタンは撤去した。`dialog.ts`)
 * - 文言は `textContent`、ハンドラは `addEventListener` (`sign-in-dialog.ts` と同じ約束。research §1)
 * - キー入力・貼り付け・コピーをダイアログの外へ伝えない (Cosense のショートカットとコピーの処理に拾わせない)
 * - **同期の状態と「今すぐ送る」を合算の草の直後に置く** (Issue #102)。押した後は
 *   **ダイアログを開き直さず、状態行と表示中の画像だけ差し替える** (開き直すと畳みが戻り、画像を全部取り直す)
 * - **草の URL はコンソールにもログにも出さない** (publicId が分かると誰でも見られる)
 * - **囲みの中は 1 枚の図とコピーの格子** (ADR-0026)。図の形 (期間 × マス) はダイアログの上の切り替えで全部の囲みをそろえて選び、
 *   図の URL と Cosense に貼る行もその形で作る (`worker-origin.ts` の `grassUrl`)。既定はカードの形 (直近 26 週 × 時間帯)
 * - **「設定」はここから開く** (Issue #95)。ページメニューはこのダイアログの 1 項目だけにしたので、
 *   設定への入口はここが唯一。サインインは設定のダイアログの中のクリックで始まるので、
 *   ポップアップを開く同期区間は分断されない
 */
import { CARD_FORM, type Cell, GRASS_SIZES, SPANS } from "../shared/grass.ts";
import { GUIDE_HEIGHTS, GUIDE_WIDTH, type GuideName } from "../shared/guide.ts";
import { DISTRIBUTION_URL, REPOSITORY_URL } from "../shared/links.ts";
import {
  BUTTON_CLASS,
  closeOnBackdropClick,
  DIALOG_BORDER,
  DIALOG_PADDING,
  styleDialog,
} from "./dialog.ts";
import { MENU_TITLE, SETTINGS_LABEL } from "./settings.ts";
import {
  type GraphEntry,
  INITIAL_PROJECT_GRAPHS,
  type IntegratedView,
  SEND_NOW_LABEL,
  type SyncView,
} from "./viewer.ts";
import { type GrassView, grassLine, grassUrl, guideUrl, PRIVACY_URL } from "./worker-origin.ts";

const STOPPED_EVENTS = ["keydown", "keyup", "keypress", "paste", "copy", "cut"] as const;

/**
 * 草 1 件の囲みの寸法 (Issue #124)。**枠の内側 (`INNER_*`) より枠と枠の間 (`OUTER_GAP`) を広く取る** —
 * 近接だけでもまとまりが読めるようにするため。この大小が逆になると囲みの意味が消える。
 */
const INNER_PADDING = 12;
const INNER_GAP = 8;
const OUTER_GAP = 20;

/** 囲みの枠の色。**ダイアログは常にライトで出す** (research §3) ので固定でよい。 */
const BORDER_COLOR = "#d0d7de";

/** 補足の文字色 (注意書きと下端のリンク)。草の SVG の文字色と同じ */
const MUTED_TEXT_COLOR = "#57606a";

/** 説明の帯の背景。開けることが分かるよう、本文より一段濃くしてボタンらしく見せる (#170) */
const GUIDE_BACKGROUND = "#f6f8fa";

/** コピーできたことを示す色 (GitHub の成功の緑)。白地で 4.5:1 を超える */
const SUCCESS_COLOR = "#1a7f37";

/** コピーできた印 (チェックと緑) を出しておく時間 */
export const COPIED_FEEDBACK_MS = 2000;

const SVG_NS = "http://www.w3.org/2000/svg";

/** ボタンのアイコンの形 (16 × 16 の線画。色は文字色に従う) */
const ICONS = {
  // 2 枚の四角を重ねた「コピー」
  copy: [
    ["rect", { x: "5.5", y: "5.5", width: "8.5", height: "8.5", rx: "1.5" }],
    [
      "path",
      { d: "M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" },
    ],
  ],
  check: [["path", { d: "M3 8.5l3.2 3.2L13 4.8" }]],
  // 別のタブで開く
  external: [
    ["path", { d: "M9.5 2H14v4.5M14 2L7.5 8.5" }],
    ["path", { d: "M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" }],
  ],
} as const satisfies Record<string, readonly (readonly [string, Record<string, string>])[]>;

/** 図とコピーの格子の間。狭い画面で折り返したときは縦の間隔になる */
const ROW_GAP = 16;

/** 図の外寸 (`GRASS_SIZES`)。**年を選んだら 1 年の形** (Worker も `year` があれば 1 年で描く) */
export function figureSize(view: GrassView): { readonly width: number; readonly height: number } {
  return GRASS_SIZES[view.year === undefined ? view.span : "year"][view.cell];
}

/** いちばん幅の広い形 (1 年) の幅。図は縮めずにこの幅まで出す */
const FIGURE_MAX_WIDTH = Math.max(
  ...SPANS.flatMap((span) => Object.values(GRASS_SIZES[span]).map((size) => size.width)),
);

/** 囲みの外寸の幅。いちばん広い図に、囲みの内側の余白と枠線 (1px) を足す */
const BLOCK_WIDTH = FIGURE_MAX_WIDTH + 2 * (INNER_PADDING + 1);

/**
 * ダイアログの外寸の幅の上限。囲みの幅に、ダイアログの余白と枠線を足す。**ダイアログは border-box** (`dialog.ts`) なので
 * `max-width` はこの外寸で書く。余白と枠を足し忘れると、囲みの内側が図の幅に届かず縮む (2026-10-07。Cosense でだけ起きた)
 */
export const DIALOG_MAX_WIDTH = BLOCK_WIDTH + 2 * (DIALOG_PADDING + DIALOG_BORDER);

/** コピーの格子の最小の幅。半年の図 (幅 500) の横にはこの幅で並び、1 年の図 (幅 775) では下へ折り返す */
const GRID_MIN_WIDTH = 240;

/**
 * コピーするものの種類ごとのボタンの文言、名乗り、コピーできないときの欄の名乗りの末尾。
 * ボタンの `aria-label` は「{何の}の {名乗り}」。**貼る行のボタンは短くする** — 行の名前 (「Cosense」) が
 * 何に貼るかを言っていて、長い文言だと半年の図の横の格子から囲みの外へはみ出した (2026-10-08)
 */
const COPY_KINDS = {
  url: { button: "URL をコピー", label: "URL をコピー", field: "URL" },
  line: { button: "貼る行をコピー", label: "Cosense に貼る行をコピー", field: "Cosense に貼る行" },
} as const;

/**
 * 説明に添える図の代わりの文 (Issue #182)。図が読めないとき (読み上げ・読み込みの失敗) に、要点を 1 文で伝える。
 * 図は Worker が描き、寸法は `shared/guide.ts` にある
 */
const GUIDE_ALTS: Record<GuideName, string> = {
  minutes:
    "ある日の 10:00〜10:19 を 1 分ずつ並べた例。編集した分は「書いた」、見ていて操作した分は「読んだ」、3 分操作が無い分は数えず、この 20 分の活動は 15 分になる",
  grass:
    "8 週間の草の例と色の読み方。1 マスが 1 日、1 列が 1 週間。量が多い日ほど濃く、書き寄りの日ほど黄色、読み寄りの日ほど紫、ふだんどおりの日は緑になる",
  overview:
    "読む 240 分・育てる 90 分・関わる 40 分・作る 30 分の例を、図の下の 1 本の線の割合にしたもの。作る 8%・育てる 22%・関わる 10%・読む 60% で、狭い区間は軸名を省いて % だけを出す",
};

export type GraphDialogDependencies = {
  /** `navigator.clipboard.writeText`。**クリックの処理から await を挟まずに呼ぶ** (Safari はユーザー操作の直後でないと拒む) */
  readonly writeText: (text: string) => Promise<void>;
  /** 期間の選択肢の「今年」を決める。既定は `Date.now` */
  readonly now?: () => number;
};

/**
 * 期間の選択肢の最も古い年 (#177)。Worker が記録を受け始めたのが 2026 年で、導入前の活動は遡らない (design §9)。
 * 選択肢は去年からここまで。**今年は並べない** — `?year=` は右端を今日に落として 53 週を遡るので、
 * 今年を選ぶと直近 1 年と同じ絵になる (`src/worker/params.ts` の `parseYear`)。
 * そのため 2026 年のあいだは年の選択肢が無く、2027 年から並ぶ
 */
export const FIRST_YEAR = 2026;

/** 期間の選択肢 (年を除く)。値は `span` */
export const SPAN_LABELS = { half: "直近 26 週", year: "直近 1 年" } as const;

/** マスの選択肢 */
export const CELL_LABELS: Record<Cell, string> = { slot: "時間帯 (朝・昼・夜)", day: "1 日" };

/** 「今すぐ送る」の結果 (`settings-dialog.ts` の `danger()` と同じ、返り値を差し込む形) */
export type SendNowResult = {
  /** 押した結果としてボタンの横に出す文言 */
  readonly text: string;
  /** 押した後の状態。状態行を描き直すのに使う */
  readonly view: SyncView;
  /** サーバの記録が変わったか。true なら表示中の草を取り直す */
  readonly refresh: boolean;
};

export type GraphDialogHandlers = {
  /** 「設定」を開く。**このダイアログを閉じてから呼ばれる** (2 枚重ねない) */
  openSettings(): void;
  /** まだ送れていない記録を今すぐ送る。**押せるときだけ呼ばれる** */
  sendNow(): Promise<SendNowResult>;
};

export type GraphDialog = {
  open(view: IntegratedView, handlers: GraphDialogHandlers): void;
  close(): void;
};

/** 表示中の図 1 枚。`latest` は最後に頼んだ読み直し (それ以外の読み込みが後から終わっても差し替えない) */
type Frame = {
  readonly frame: HTMLElement;
  readonly src: (bust?: number) => string;
  readonly make: (lazy: boolean) => HTMLImageElement;
  readonly fail: () => void;
  latest?: HTMLImageElement;
};

export function createGraphDialog(doc: Document, deps: GraphDialogDependencies): GraphDialog {
  let dialog: HTMLDialogElement | undefined;
  /**
   * 表示中の図。送った後と形を替えた後に取り直す。`fail` は読めなかったときに枠へ出すもの
   * (形を替えて読めなかったとき、前の形の絵を残すと別の形の絵と取り違える)
   */
  let frames: Frame[] = [];
  /** 選んでいる形 (ADR-0026)。**開くたびに既定 (カードの形) へ戻す** (#177) */
  let view: GrassView = CARD_FORM;

  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElement(tag);
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  };

  const button = (text: string, onClick: () => void) => {
    const node = element("button", text);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  };

  /** ボタンの頭に置く 14px のアイコン。飾りなので読み上げない。`innerHTML` は使わない */
  const icon = (kind: keyof typeof ICONS) => {
    const svg = doc.createElementNS(SVG_NS, "svg");
    for (const [name, value] of Object.entries({
      width: "14",
      height: "14",
      viewBox: "0 0 16 16",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.5",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      "data-icon": kind,
    })) {
      svg.setAttribute(name, value);
    }
    for (const [tag, attributes] of ICONS[kind]) {
      const shape = doc.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attributes)) {
        shape.setAttribute(name, value);
      }
      svg.append(shape);
    }
    return svg;
  };

  const close = () => {
    const current = dialog;
    if (current === undefined) {
      return;
    }
    dialog = undefined;
    if (current.open) {
      current.close();
    }
    current.remove();
  };

  /**
   * **キャッシュを外すクエリは `<img>` にだけ付ける** (Issue #102)。
   * 共有 SVG は `max-age=900` なので、送った直後に同じ URL で読むとブラウザのキャッシュから古い絵が返る。
   * Worker は未知のクエリを無視する (`params.ts`)。**コピーする URL には混ぜない** (他人に渡すものなので)。
   * URL にはすでにクエリ (`l` / `u` や形) が付いていることがあるので、2 つ目からは `&` で継ぐ
   */
  const srcOf = (url: string, bust?: number) => {
    if (bust === undefined) {
      return url;
    }
    return `${url}${url.includes("?") ? "&" : "?"}r=${bust}`;
  };

  /**
   * 図 (ADR-0026)。**寸法は選んでいる形の外寸** (`GRASS_SIZES`) を属性で先に確保し、狭ければ縦横比を保って縮める。
   * 読めなければ文言に置き換える。**送れていない図も最初から読む** (2026-09-24) — ほかの端末から送っていれば図はある。
   * 読めなかったときは、送れたかどうかで理由を言い分ける (送れているのに読めないのは、サーバに届かないとき)
   */
  const figure = (entry: GraphEntry) => {
    const frame = element("div");
    // 囲みより図が広い画面 (スマホ) では、枠ごと縮める
    frame.style.flex = "0 1 auto";
    frame.style.minWidth = "0";
    frame.style.maxWidth = "100%";
    const make = (lazy: boolean) => {
      const img = element("img");
      const size = figureSize(view);
      img.width = size.width;
      img.height = size.height;
      img.alt = `${entry.label} の図`;
      if (lazy) {
        // 属性で付ける (jsdom は loading の IDL 属性を持たない)
        img.setAttribute("loading", "lazy");
      }
      img.setAttribute("referrerpolicy", "no-referrer");
      // style 属性は Cosense の CSP で許されている (research §1)
      Object.assign(img.style, { display: "block", maxWidth: "100%", height: "auto" });
      return img;
    };
    const fail = () => {
      frame.replaceChildren(
        element(
          "p",
          entry.sent
            ? "図を表示できませんでした (サーバに届かないか、まだ記録が反映されていません)。"
            : "このブラウザからはまだ送っていません。ほかの端末からも送っていなければ、図はまだありません。",
        ),
      );
    };
    const src = (bust?: number) => srcOf(grassUrl(entry.publicId, view, entry.names), bust);
    const img = make(true);
    const target: Frame = { frame, src, make, fail, latest: img };
    // 形を替えた後に最初の図の失敗が届いても、新しい形の図を文言で上書きしない
    img.addEventListener("error", () => {
      if (target.latest === img) {
        fail();
      }
    });
    img.src = src();
    frame.append(img);
    frames.push(target);
    return frame;
  };

  /**
   * 送った後に、表示中の図を取り直す。**新しい絵が読めてから差し替える** —
   * 取り直しが失敗したときに、見えていた図が文言に化けないようにする。
   */
  const refreshGraphs = () => {
    const bust = Date.now();
    for (const target of frames) {
      reload(target, target.src(bust), false);
    }
  };

  /**
   * 1 枚を読み直す。**最後に頼んだものだけが差し替えられる** — 形を続けて替えると、先に頼んだ古い形の読み込みが
   * 後から終わることがあり、そのまま差し替えると選んだ形と違う絵が残る (2026-10-08 に確認用のページで起きた)。
   * `failOnError` が false なら、読めなくても今の絵を残す (送った後の取り直し)
   */
  const reload = (target: Frame, url: string, failOnError: boolean) => {
    const next = target.make(false);
    target.latest = next;
    next.addEventListener("load", () => {
      if (target.latest === next) {
        target.frame.replaceChildren(next);
      }
    });
    if (failOnError) {
      next.addEventListener("error", () => {
        if (target.latest === next) {
          target.fail();
        }
      });
    }
    next.src = url;
  };

  /**
   * 形を替えたときに、表示中の図を選んだ形の URL で読み直す (#177・ADR-0026)。**読めてから差し替える**。
   * 読めなければ枠を文言に替える — 前の形の絵を残すと、別の形の絵と取り違える
   */
  const reloadGraphs = () => {
    for (const target of frames) {
      reload(target, target.src(), true);
    }
  };

  /**
   * 図の形の切り替え (ADR-0026)。**ダイアログ全体で 1 か所**に置き、すべての囲みの図と、コピーする URL・貼る行をそろえて替える。
   *
   * - 期間: 「直近 26 週」「直近 1 年」と、去年から `FIRST_YEAR` までの各年 (#177)。年を選ぶと 1 年になる
   * - マス: 時間帯 (朝・昼・夜の 3 マス) か 1 日 1 マス
   */
  const viewPicker = (): HTMLElement => {
    const line = element("div");
    Object.assign(line.style, {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      gap: `${INNER_GAP}px ${ROW_GAP}px`,
      margin: `${OUTER_GAP}px 0 0`,
    });
    const labelled = (text: string, control: HTMLElement) => {
      const label = element("label");
      Object.assign(label.style, { display: "inline-flex", alignItems: "center", gap: "8px" });
      const name = element("span", text);
      name.style.fontWeight = "bold";
      label.append(name, control);
      return label;
    };

    const period = element("select");
    const option = (value: string, text: string) => {
      const node = element("option", text);
      node.value = value;
      return node;
    };
    for (const span of SPANS) {
      period.append(option(span, SPAN_LABELS[span]));
    }
    const lastYear = new Date((deps.now ?? Date.now)()).getFullYear() - 1;
    for (let year = lastYear; year >= FIRST_YEAR; year--) {
      period.append(option(String(year), `${year} 年`));
    }
    period.value = view.span;
    period.addEventListener("change", () => {
      const value = period.value;
      view =
        value === "half" || value === "year"
          ? { span: value, cell: view.cell }
          : { span: "year", cell: view.cell, year: Number(value) };
      reloadGraphs();
    });

    // マスは 2 択なので、並べて見える radio にする (select だと開くまで選択肢が見えない)
    const cells = element("span");
    cells.setAttribute("role", "radiogroup");
    cells.setAttribute("aria-label", "マス");
    Object.assign(cells.style, { display: "inline-flex", alignItems: "center", gap: "12px" });
    const cellsName = element("span", "マス");
    cellsName.style.fontWeight = "bold";
    cells.append(cellsName);
    for (const cell of ["slot", "day"] as const) {
      const label = element("label");
      Object.assign(label.style, { display: "inline-flex", alignItems: "center", gap: "4px" });
      const radio = element("input");
      radio.type = "radio";
      radio.name = "cosense-grass-cell";
      radio.value = cell;
      radio.checked = view.cell === cell;
      radio.addEventListener("change", () => {
        if (radio.checked) {
          view = { ...view, cell };
          reloadGraphs();
        }
      });
      label.append(radio, CELL_LABELS[cell]);
      cells.append(label);
    }

    const hint = element("span", "すべての図と、コピーする URL・貼る行がこの形になります");
    hint.style.fontSize = "smaller";
    hint.style.color = MUTED_TEXT_COLOR;
    line.append(labelled("期間", period), cells, hint);
    return line;
  };

  /** 同期の状態と「今すぐ送る」。押した後はここだけ描き直す */
  const sync = (view: SyncView, handlers: GraphDialogHandlers) => {
    const block = element("div");
    const lines = element("div");
    const line = element("p");
    const status = element("span");
    status.setAttribute("role", "status");
    const send = element("button");
    send.type = "button";
    send.textContent = SEND_NOW_LABEL;

    const render = (current: SyncView) => {
      lines.replaceChildren(...current.lines.map((text) => element("p", text)));
      send.disabled = !current.canSend;
    };

    send.addEventListener("click", () => {
      // 待っている間に押し直させない (Web Locks で直列にはなるが、押した実感が無いと連打される)
      send.disabled = true;
      status.textContent = " 送っています…";
      handlers.sendNow().then(
        (result) => {
          status.textContent = ` ${result.text}`;
          render(result.view);
          if (result.refresh) {
            refreshGraphs();
          }
        },
        () => {
          status.textContent = " 送れませんでした。";
          send.disabled = false;
        },
      );
    });

    render(view);
    line.append(send, status);
    block.append(lines, line);
    return block;
  };

  /**
   * 「共有する」の欄の 1 行。名前・(あれば) 開くリンク・「URL をコピー」を並べる。
   * コピーできなければ、選んでコピーできる欄を行の下に出す (押し直しても欄は 1 つ)。
   * ボタンの文言は短いままにし、**何の URL かは名前と `aria-label` で示す** (Issue #124)
   */
  const copyLine = (target: {
    readonly name: string;
    /** コピーするもの。**押した時点の形で作る** (形を替えて押し直したら、その形の URL・行になる)。`kind` が `line` なら Cosense に貼る行 */
    readonly value: () => string;
    readonly what: string;
    /** あれば「開く」のリンクを並べる (日ごとの数値) */
    readonly open?: string;
    /** 既定は `url` */
    readonly kind?: keyof typeof COPY_KINDS;
  }) => {
    const kind = COPY_KINDS[target.kind ?? "url"];
    // 名前と操作の 2 つのセルを返す。並べる側 (`shareGrid`) の格子で名前の列の幅がそろう
    const name = element("span", target.name);
    const line = element("div");
    line.style.display = "flex";
    line.style.flexWrap = "wrap";
    line.style.alignItems = "center";
    line.style.gap = "4px 8px";
    const status = element("span");
    status.setAttribute("role", "status");
    status.style.fontSize = "smaller";
    let field: HTMLInputElement | undefined;
    let copyIcon = icon("copy");
    let reset: ReturnType<typeof setTimeout> | undefined;
    /** コピーできた印 (チェックと緑) を出すか戻すか。文言と `aria-label` は変えない */
    const showCopied = (copied: boolean) => {
      const next = icon(copied ? "check" : "copy");
      copyIcon.replaceWith(next);
      copyIcon = next;
      copy.style.color = copied ? SUCCESS_COLOR : "";
      copy.style.borderColor = copied ? SUCCESS_COLOR : "";
      status.style.color = copied ? SUCCESS_COLOR : "";
      if (!copied) {
        status.textContent = "";
      }
    };
    const copy = button(kind.button, () => {
      clearTimeout(reset);
      const url = target.value();
      // await を挟まずに呼ぶ。結果は後から書く
      deps.writeText(url).then(
        () => {
          status.textContent = "コピーしました";
          showCopied(true);
          reset = setTimeout(() => showCopied(false), COPIED_FEEDBACK_MS);
        },
        () => {
          showCopied(false);
          if (field === undefined) {
            field = element("input");
            field.type = "text";
            field.readOnly = true;
            field.style.width = "100%";
            field.style.boxSizing = "border-box";
            field.setAttribute("aria-label", `${target.what}の ${kind.field}`);
            line.append(field);
          }
          // 形を替えて押し直したら、欄もその形の URL にする
          field.value = url;
          status.textContent = "コピーできなかったので、下の欄から選んでコピーしてください";
          field.select();
        },
      );
    });
    copy.prepend(copyIcon);
    copy.setAttribute("aria-label", `${target.what}の ${kind.label}`);
    // コピーを先に置き、行ごとの「URL をコピー」の位置をそろえる
    line.append(copy);
    if (target.open !== undefined) {
      // 「URL をコピー」と並ぶので、リンクのままボタンの見た目にする
      const open = externalLink("開く", target.open, `${target.what}を開く`);
      open.classList.add(BUTTON_CLASS);
      open.prepend(icon("external"));
      line.append(open);
    }
    line.append(status);
    return [name, line];
  };

  /** 別のタブで開くリンク。**Referer を送らず、開いた先から opener を触らせない** */
  const externalLink = (text: string, href: string, label?: string) => {
    const link = element("a", text);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (label !== undefined) {
      link.setAttribute("aria-label", label);
    }
    return link;
  };

  /**
   * 図の URL・Cosense に貼る行・日ごとの数値のコピーを並べる格子。図の右 (狭いときと 1 年の図では下) に置く。
   * 何の URL かはボタンの `aria-label` が言う。日ごとの数値の注意は囲みの下端の 1 行 (`dataNote`) にする
   */
  const shareGrid = (entry: GraphEntry) => {
    const rows = element("div");
    Object.assign(rows.style, {
      display: "grid",
      gridTemplateColumns: "max-content minmax(0, 1fr)",
      alignItems: "center",
      gap: "4px 12px",
      flex: `1 1 ${GRID_MIN_WIDTH}px`,
      minWidth: "0",
    });
    const what = `${entry.label} の図`;
    rows.append(
      ...copyLine({
        name: "図",
        value: () => grassUrl(entry.publicId, view, entry.names),
        what,
      }),
      ...copyLine({
        name: "Cosense",
        value: () => grassLine(entry.publicId, view, entry.names),
        what,
        kind: "line",
      }),
      ...copyLine({
        name: "数値 (JSON)",
        value: () => entry.dataUrl,
        what: `${entry.label} の日ごとの数値`,
        open: entry.dataUrl,
      }),
    );
    return rows;
  };

  /**
   * 日ごとの数値の URL を渡すと何が読めるかの注意 (ADR-0020 の 2026-09-26 の改訂)。**その場に添える** —
   * 図の URL と同じ気軽さで渡されないように。囲みの下端に 1 行で置く
   */
  const dataNote = () => {
    const note = element(
      "p",
      "数値 (JSON) の URL を渡すと、日ごとの内訳まで読めます (図の URL からは作れない別の URL で、形によらず全期間の値)。",
    );
    note.style.margin = `${INNER_GAP}px 0 0`;
    note.style.fontSize = "smaller";
    note.style.color = MUTED_TEXT_COLOR;
    return note;
  };

  /**
   * 1 つの図 (見出し・図・コピー) を**枠で囲む** (Issue #124)。
   *
   * 囲まずに縦へ並べると、コピーボタンが上の図のものか下の図のものか読み取れない。
   * **共通領域** (同じ囲みの中は 1 つのまとまり) と**近接** (枠の内側 < 枠と枠の間) の両方で示す。
   * 片方だけに頼らないのは、枠線が見えにくい環境でも間隔でまとまりが読めるようにするため。
   *
   * 中は図とコピーの格子を横に並べ、入らなければ (1 年の図・狭い画面) 格子を図の下へ折り返す
   */
  const graph = (entry: GraphEntry) => {
    const block = element("section");
    block.style.border = `1px solid ${BORDER_COLOR}`;
    block.style.borderRadius = "8px";
    block.style.padding = `${INNER_PADDING}px`;
    block.style.margin = `${OUTER_GAP}px 0`;
    const heading = element("h4", entry.label);
    heading.style.margin = `0 0 ${INNER_GAP}px`;
    const row = element("div");
    Object.assign(row.style, {
      display: "flex",
      flexWrap: "wrap",
      alignItems: "flex-start",
      gap: `${ROW_GAP}px`,
    });
    row.append(figure(entry), shareGrid(entry));
    block.append(heading, row, dataNote());
    return block;
  };

  /** 先頭の `INITIAL_PROJECT_GRAPHS` 件だけ出し、残りは押すと出す */
  const appendLimited = <T>(
    section: HTMLElement,
    items: readonly T[],
    render: (item: T) => Node,
  ) => {
    section.append(...items.slice(0, INITIAL_PROJECT_GRAPHS).map(render));
    const rest = items.slice(INITIAL_PROJECT_GRAPHS);
    if (rest.length > 0) {
      const more = button(`ほか ${rest.length} 件を表示`, () => {
        more.replaceWith(...rest.map(render));
      });
      section.append(more);
    }
  };

  /** 説明の図。**狭い画面では縦横比を保って縮む** (幅と高さは属性で先に確保する) */
  const guideFigure = (name: GuideName) => {
    const img = element("img");
    img.src = guideUrl(name);
    img.alt = GUIDE_ALTS[name];
    // 説明は畳んであるので、開くまで取りに行かない
    img.loading = "lazy";
    img.width = GUIDE_WIDTH;
    img.height = GUIDE_HEIGHTS[name];
    Object.assign(img.style, {
      display: "block",
      maxWidth: "100%",
      height: "auto",
      margin: "4px 0 8px",
    });
    return img;
  };

  /** 見出しと、図 (あれば)、本文の段落を持つ説明の 1 節 */
  const guideSection = (
    title: string,
    figure: GuideName | undefined,
    ...paragraphs: readonly (string | readonly string[])[]
  ) => {
    const nodes: HTMLElement[] = [element("h4", title)];
    if (figure !== undefined) {
      nodes.push(guideFigure(figure));
    }
    for (const paragraph of paragraphs) {
      if (typeof paragraph === "string") {
        nodes.push(element("p", paragraph));
      } else {
        const list = element("ul");
        list.append(...paragraph.map((item) => element("li", item)));
        nodes.push(list);
      }
    }
    return nodes;
  };

  /**
   * 説明の見出しの帯 (#170)。素の `summary` では既定の小さな三角しか手がかりが無く、開けることに気付きにくかった。
   * 背景でボタンらしくし (枠は `details` 全体に付ける)、左に「?」、右端に「開く / 閉じる」と向きの変わる山形を置く。
   * `[open]` のセレクタはインラインの style で書けないので、`toggle` で文言と向きを変える
   */
  const guideSummary = (details: HTMLDetailsElement) => {
    const summary = element("summary");
    Object.assign(summary.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "6px 10px",
      background: GUIDE_BACKGROUND,
      cursor: "pointer",
      listStyle: "none",
    });
    // 飾りは読み上げない。開閉の状態は `details` が支援技術へ伝える
    const decoration = (text: string) => {
      const node = element("span", text);
      node.setAttribute("aria-hidden", "true");
      return node;
    };
    const icon = decoration("?");
    Object.assign(icon.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      flex: "none",
      width: "16px",
      height: "16px",
      borderRadius: "50%",
      border: `1.5px solid ${MUTED_TEXT_COLOR}`,
      color: MUTED_TEXT_COLOR,
      fontSize: "11px",
      fontWeight: "bold",
      lineHeight: "1",
    });
    const title = element("span", "図の見方");
    title.style.fontWeight = "bold";
    const hint = decoration("");
    Object.assign(hint.style, { marginLeft: "auto", color: MUTED_TEXT_COLOR, fontSize: "0.9em" });
    const chevron = decoration("›");
    Object.assign(chevron.style, {
      display: "inline-block",
      color: MUTED_TEXT_COLOR,
      fontSize: "1.2em",
      lineHeight: "1",
      transition: "transform 0.15s",
    });
    summary.append(icon, title, hint, chevron);

    const sync = () => {
      hint.textContent = details.open ? "閉じる" : "開く";
      chevron.style.transform = details.open ? "rotate(90deg)" : "";
      // 開いているときだけ見出しと本文を区切る。閉じているときは囲みの枠と重なって二重線になる
      summary.style.borderBottom = details.open ? `1px solid ${BORDER_COLOR}` : "";
    };
    details.addEventListener("toggle", sync);
    sync();
    return summary;
  };

  /**
   * 何をどう数えて描いているか (#164)。**畳んでおく** — 毎回読むものではないので、図を押し下げない。
   * 数値は実装に合わせる (sensor.ts の 3 分・20 秒、design §7 の四分位と 3 分のデッドゾーン、ADR-0021 の 4 軸、ADR-0024 の時間帯)
   */
  const guide = () => {
    const details = element("details");
    // 枠は見出しでなく `details` 全体に付け、開いたときに本文まで 1 つの囲みにする (#173)。
    // 本文が枠なしで続くと、どこまでが説明か分からなかった。角の背景を枠の丸みで切るため `overflow: hidden`
    Object.assign(details.style, {
      border: `1px solid ${BORDER_COLOR}`,
      borderRadius: "6px",
      overflow: "hidden",
    });
    const summary = guideSummary(details);
    const privacy = element("p");
    privacy.append(
      "サーバに送るのは分ごとの記録と数 (編集したページ数など) だけで、ページ名・本文・リンク先は送りません。プロジェクト名もハッシュにして送ります。詳しくは",
      externalLink("プライバシーポリシー", PRIVACY_URL),
      "をご覧ください。",
    );
    const body = element("div");
    body.style.padding = "4px 12px 8px";
    body.append(
      ...guideSection(
        "数えているもの",
        "minutes",
        "1 日を 1 分ずつに区切り、分ごとに「書いた」か「読んだ」かだけを記録します。",
        [
          "書いた: その分に自分でページを編集した",
          "読んだ: 画面が見えていてフォーカスがあり、直近 3 分以内にスクロールやキー入力などの操作があった (20 秒ごとに確かめます)",
        ],
        "同じ分に両方あれば「書いた」に数えます。数えるのは、自分のページで cosense-grass を読み込んでいるプロジェクトだけです。",
      ),
      ...guideSection(
        "草",
        "grass",
        "1 列が 1 週間です。既定は直近 26 週で、1 日を朝 (9〜13 時)・昼 (13〜18 時)・夜 (18 時〜翌 9 時) の 3 マスに分けます (夜は翌朝 9 時までをその日に数えます)。上の「期間」と「マス」で、1 年分や 1 日 1 マスに切り替えられます。2027 年からは過去の年も選べます。",
        [
          "濃さ: その日 (時間帯) の合計 (書いた分 + 読んだ分) を、これまでの全記録の分布 (四分位) で 4 段階に分けたもの。3 分未満は色を付けません",
          "色合い: 自分のふだんの比率 (全記録の中央値) を真ん中にして、書き寄りほど黄色、読み寄りほど紫、ふだんどおりは緑になります",
          "記録を始める前の日は点線の枠です。時間帯を記録し始める前の日は、その日の合計の色を 3 マスに薄く塗ります",
        ],
      ),
      ...guideSection(
        "草の下の線",
        "overview",
        "同じ期間の分を、作る・育てる・関わる・読むの 4 つに分けた割合です。どの分も 1 つにしか数えません。",
        "書いたページがどれにあたるかは、そのページを最初に編集したときに、作成者と作成日を Cosense に問い合わせて決めます。1 本の線を 4 つの軸が割合で取り合い、線の下に軸名と % を小さく添えます (狭い区間は % だけ)。% は分の割合そのもので、合計が 100 になるよう丸めています。",
      ),
      ...guideSection(
        "貼る行と自分のページ",
        undefined,
        "「貼る行をコピー」で、選んでいる形の図を Cosense に出す画像の行をコピーできます。「URL をコピー」も同じ形の図の URL です。",
        "cosense-grass を読み込んでいるプロジェクトでは、自分のページ (ユーザー名のページ) の読み込みのコードの下に、そのプロジェクトの図 (直近 26 週 × 時間帯) の行を自動で貼ります。消しても次に開いたときに貼り直します。止めるには、自分のページから読み込みの 1 行を外してください。",
      ),
      ...guideSection("送るもの", undefined),
      privacy,
    );
    // Safari の既定の三角は、ダイアログの `<style>` が消す (`dialog.ts`)
    details.append(summary, body);
    return details;
  };

  /** 下端の行。左に「設定」、右に関連するページへのリンク */
  const footer = (handlers: GraphDialogHandlers) => {
    const line = element("div");
    line.style.display = "flex";
    line.style.flexWrap = "wrap";
    line.style.alignItems = "center";
    line.style.justifyContent = "space-between";
    line.style.gap = `${INNER_GAP}px ${ROW_GAP}px`;
    line.style.marginTop = `${OUTER_GAP}px`;
    const links = element("nav");
    links.setAttribute("aria-label", "cosense-grass について");
    links.style.fontSize = "smaller";
    links.style.color = MUTED_TEXT_COLOR;
    const items = [
      externalLink("配布ページ (Cosense)", DISTRIBUTION_URL),
      externalLink("ソースコード (GitHub)", REPOSITORY_URL),
      externalLink("プライバシーポリシー", PRIVACY_URL),
    ];
    items.forEach((item, i) => {
      if (i > 0) {
        links.append(" ・ ");
      }
      links.append(item);
    });
    line.append(
      // 閉じてから開く。設定のダイアログは自分で状況を読み直す
      button(SETTINGS_LABEL, () => {
        close();
        handlers.openSettings();
      }),
      links,
    );
    return line;
  };

  const integrated = (records: IntegratedView, handlers: GraphDialogHandlers) => {
    const section = element("section");
    section.append(element("h3", "全端末を統合した記録"));
    if (records.kind === "message") {
      section.append(...records.lines.map((line) => element("p", line)), guide());
      return section;
    }
    section.append(
      element(
        "p",
        "同じ Google アカウントで登録した端末の記録をまとめた図です。ほかの人に見せる図は最大 15 分遅れて更新され、今日の列は日本時間で決まります。",
      ),
      guide(),
      viewPicker(),
      graph(records.total),
      sync(records.sync, handlers),
    );

    if (records.projects.length === 0) {
      section.append(
        element("p", "このブラウザで直近 30 日に記録したプロジェクトはまだありません。"),
      );
      return section;
    }
    appendLimited(section, records.projects, graph);
    section.append(
      element(
        "p",
        "プロジェクト別に並ぶのは、このブラウザで直近 30 日に記録したプロジェクトです。ほかの端末だけで使っているプロジェクトは、そのプロジェクトを開いて記録すると並びます。",
      ),
    );
    return section;
  };

  return {
    open(records, handlers) {
      close();
      frames = [];
      view = CARD_FORM;
      const node = element("dialog");
      styleDialog(node);
      // 長い説明文で画面の幅いっぱいに広がらないよう、囲みの幅に余白と枠を足したところで止める
      // 画面側の上限は既定 (`calc(100% - 6px - 2em)`) のまま。これより大きいと、余白と枠のぶん画面からはみ出す (#164)
      node.style.maxWidth = `min(${DIALOG_MAX_WIDTH}px, calc(100% - 6px - 2em))`;
      for (const type of STOPPED_EVENTS) {
        node.addEventListener(type, (event) => event.stopPropagation());
      }
      node.addEventListener("close", () => {
        if (dialog === node) {
          close();
        }
      });
      closeOnBackdropClick(node, close);

      node.append(element("h2", MENU_TITLE), integrated(records, handlers), footer(handlers));

      doc.body.append(node);
      dialog = node;
      node.showModal();
      // **開いたらダイアログそのものへフォーカスを移す。** 既定では最初の操作できる要素 (説明の見出し) に当たり、枠が出る。
      // Esc と Tab はそのまま効く
      node.tabIndex = -1;
      node.style.outline = "none";
      node.focus();
    },

    close,
  };
}
