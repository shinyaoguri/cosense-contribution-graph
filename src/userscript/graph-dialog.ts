/**
 * 草のダイアログ (design §9「表示」、段階 8、Issue #73)。何を並べるかは `viewer.ts` が決める。
 *
 * - **ページに挿さずダイアログにする。** Cosense の遷移で消えないので、再マウントが要らない (ADR-0003 の改訂)
 * - **草は常にライトで出す。** 素の `<dialog>` は Cosense のどのテーマでも白地に黒 (research §3 の 2026-09-15 の実測)
 * - **出すのは Worker が作った共有 SVG の `<img>` だけ** (ADR-0019、Issue #109)。ここは草を描かない。
 *   ~~このブラウザから送れていないものは、押されるまで読まない~~ **2026-09-24 に最初から読むよう改めた**
 *   (押す手間の方が煩わしかった)。読めなかったときの文言だけを、送れたかどうかで言い分ける
 * - **閉じるのは外側のクリックと Esc** (2026-09-24。「閉じる」ボタンは撤去した。`dialog.ts`)
 * - 文言は `textContent`、ハンドラは `addEventListener` (`sign-in-dialog.ts` と同じ約束。research §1)
 * - キー入力・貼り付け・コピーをダイアログの外へ伝えない (Cosense のショートカットとコピーの処理に拾わせない)
 * - **同期の状態と「今すぐ送る」を合算の草の直後に置く** (Issue #102)。押した後は
 *   **ダイアログを開き直さず、状態行と表示中の画像だけ差し替える** (開き直すと畳みが戻り、画像を全部取り直す)
 * - **草の URL はコンソールにもログにも出さない** (publicId が分かると誰でも見られる)
 * - **「設定」はここから開く** (Issue #95)。ページメニューはこのダイアログの 1 項目だけにしたので、
 *   設定への入口はここが唯一。サインインは設定のダイアログの中のクリックで始まるので、
 *   ポップアップを開く同期区間は分断されない
 */
import { DISTRIBUTION_URL, REPOSITORY_URL } from "../shared/links.ts";
import { closeOnBackdropClick } from "./dialog.ts";
import { MENU_TITLE, SETTINGS_LABEL } from "./settings.ts";
import {
  type GraphEntry,
  INITIAL_PROJECT_GRAPHS,
  type IntegratedView,
  SEND_NOW_LABEL,
  type SyncView,
} from "./viewer.ts";
import { PRIVACY_URL } from "./worker-origin.ts";

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

/** 概観と「共有する」の欄の間。狭い画面で折り返したときは縦の間隔になる */
const ROW_GAP = 16;

/** 53 週の既定の SVG の寸法 (design §8)。先に確保して、読み込みでダイアログの大きさが変わらないようにする */
export const GRAPH_WIDTH = 775;
export const GRAPH_HEIGHT = 146;

/** 活動の概観の SVG の寸法 (design §8、ADR-0021)。草と同じく先に確保する */
export const OVERVIEW_WIDTH = 300;
export const OVERVIEW_HEIGHT = 220;

export type GraphDialogDependencies = {
  /** `navigator.clipboard.writeText`。**クリックの処理から await を挟まずに呼ぶ** (Safari はユーザー操作の直後でないと拒む) */
  readonly writeText: (text: string) => Promise<void>;
};

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

export function createGraphDialog(doc: Document, deps: GraphDialogDependencies): GraphDialog {
  let dialog: HTMLDialogElement | undefined;
  /** 表示中の統合の草。送った後にここだけ取り直す */
  // 送った後に取り直す画像。草と概観の両方
  let frames: { url: string; frame: HTMLElement; make: (lazy: boolean) => HTMLImageElement }[] = [];

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

  const imageElement = (
    size: { readonly width: number; readonly height: number; readonly alt: string },
    lazy: boolean,
  ) => {
    const img = element("img");
    img.width = size.width;
    img.height = size.height;
    img.alt = size.alt;
    if (lazy) {
      // 属性で付ける (jsdom は loading の IDL 属性を持たない)
      img.setAttribute("loading", "lazy");
    }
    img.setAttribute("referrerpolicy", "no-referrer");
    img.style.maxWidth = "none";
    return img;
  };

  /**
   * **キャッシュを外すクエリは `<img>` にだけ付ける** (Issue #102)。
   * 共有 SVG は `max-age=900` なので、送った直後に同じ URL で読むとブラウザのキャッシュから古い絵が返る。
   * Worker は未知のクエリを無視する (`params.ts`)。**コピーする URL には混ぜない** (他人に渡すものなので)。
   *
   * **URL にすでにクエリが付いていることがある** — プロジェクト別の草には名前が `?l=` で載る
   * (Issue #119)。`?` を 2 つ並べると URL が壊れるので、2 つ目からは `&` で継ぐ。
   */
  const srcOf = (url: string, bust?: number) => {
    if (bust === undefined) {
      return url;
    }
    return `${url}${url.includes("?") ? "&" : "?"}r=${bust}`;
  };

  /**
   * 草の画像。読めなければ文言に置き換える。**送れていない草も最初から読む** (2026-09-24) —
   * ほかの端末から送っていれば草はある。読めなかったときは、送れたかどうかで理由を言い分ける
   * (送れているのに読めないのは、サーバに届かないとき)
   */
  const image = (entry: GraphEntry) => {
    const frame = element("div");
    // 狭い画面では横にスクロールする (style 属性は Cosense の CSP で許されている。research §1)
    frame.style.overflowX = "auto";
    const make = (lazy: boolean) =>
      imageElement({ width: GRAPH_WIDTH, height: GRAPH_HEIGHT, alt: `${entry.label} の草` }, lazy);
    const img = make(true);
    img.addEventListener("error", () => {
      frame.replaceChildren(
        element(
          "p",
          entry.sent
            ? "草を表示できませんでした (サーバに届かないか、まだ記録が反映されていません)。"
            : "このブラウザからはまだ送っていません。ほかの端末からも送っていなければ、草はまだありません。",
        ),
      );
    });
    img.src = srcOf(entry.url);
    frame.append(img);
    frames.push({ url: entry.url, frame, make });
    return frame;
  };

  /**
   * 活動の概観 (ADR-0021)。草の下に置く。**読めなければ何も出さない** — 読めない理由は草の側で言っている
   * (概観は草と同じ publicId なので、草が読めれば概観も読める)
   */
  const overview = (entry: GraphEntry) => {
    const frame = element("div");
    // 画像が読めずに消えても、欄の位置が動かないよう幅を取っておく
    frame.style.flex = `0 0 ${OVERVIEW_WIDTH}px`;
    frame.style.minHeight = `${OVERVIEW_HEIGHT}px`;
    const make = (lazy: boolean) =>
      imageElement(
        { width: OVERVIEW_WIDTH, height: OVERVIEW_HEIGHT, alt: `${entry.label} の活動の概観` },
        lazy,
      );
    const img = make(true);
    img.addEventListener("error", () => {
      frame.replaceChildren();
    });
    img.src = srcOf(entry.overviewUrl);
    frame.append(img);
    frames.push({ url: entry.overviewUrl, frame, make });
    return frame;
  };

  /**
   * 送った後に、表示中の草を取り直す。**新しい絵が読めてから差し替える** —
   * 取り直しが失敗したときに、見えていた草が文言に化けないようにする。
   */
  const refreshGraphs = () => {
    const bust = Date.now();
    for (const { url, frame, make } of frames) {
      const next = make(false);
      next.addEventListener("load", () => {
        frame.replaceChildren(next);
      });
      next.src = srcOf(url, bust);
    }
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
    readonly url: string;
    readonly what: string;
    readonly open?: boolean;
  }) => {
    // 名前と操作の 2 つのセルを返す。並べる側 (`share`) の格子で名前の列の幅がそろう
    const name = element("span", target.name);
    const line = element("div");
    line.style.display = "flex";
    line.style.flexWrap = "wrap";
    line.style.alignItems = "center";
    line.style.gap = "4px 8px";
    const status = element("span");
    status.setAttribute("role", "status");
    let field: HTMLInputElement | undefined;
    const copy = button("URL をコピー", () => {
      // await を挟まずに呼ぶ。結果は後から書く
      deps.writeText(target.url).then(
        () => {
          status.textContent = "コピーしました";
        },
        () => {
          if (field === undefined) {
            field = element("input");
            field.type = "text";
            field.readOnly = true;
            field.value = target.url;
            field.style.width = "100%";
            field.style.boxSizing = "border-box";
            field.setAttribute("aria-label", `${target.what}の URL`);
            line.append(field);
          }
          status.textContent = "コピーできなかったので、下の欄から選んでコピーしてください";
          field.select();
        },
      );
    });
    copy.setAttribute("aria-label", `${target.what}の URL をコピー`);
    // コピーを先に置き、行ごとの「URL をコピー」の位置をそろえる
    line.append(copy);
    if (target.open) {
      line.append(externalLink("開く", target.url, `${target.what}を開く`));
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

  /** 草・活動の概観・日ごとの数値の URL を並べる欄。概観の右 (狭い画面では下) に置く */
  const share = (entry: GraphEntry) => {
    const panel = element("div");
    // 概観の右の空きを埋め、狭くなったら概観の下へ折り返す
    panel.style.flex = "1 1 280px";
    panel.style.minWidth = "0";
    const heading = element("p", "共有する");
    heading.style.margin = `0 0 ${INNER_GAP}px`;
    heading.style.fontWeight = "bold";
    const rows = element("div");
    rows.style.display = "grid";
    rows.style.gridTemplateColumns = "max-content minmax(0, 1fr)";
    rows.style.alignItems = "center";
    rows.style.gap = `${INNER_GAP}px 12px`;
    const note = element(
      "p",
      "日ごとの数値の URL を渡すと、書いた分・読んだ分などの日ごとの内訳まで読めます。草や活動の概観の URL からは作れない、別の URL です。",
    );
    note.style.margin = `${INNER_GAP * 1.5}px 0 0`;
    note.style.fontSize = "smaller";
    note.style.color = MUTED_TEXT_COLOR;
    rows.append(
      ...copyLine({ name: "草", url: entry.url, what: `${entry.label} の草` }),
      ...copyLine({
        name: "活動の概観",
        url: entry.overviewUrl,
        what: `${entry.label} の活動の概観`,
      }),
      ...copyLine({
        name: "日ごとの数値 (JSON)",
        url: entry.dataUrl,
        what: `${entry.label} の日ごとの数値`,
        open: true,
      }),
    );
    panel.append(heading, rows, note);
    return panel;
  };

  /**
   * 1 つの草 (見出し・画像・コピー) を**枠で囲む** (Issue #124)。
   *
   * 囲まずに縦へ並べると、コピーボタンが上の画像のものか下の画像のものか読み取れない。
   * **共通領域** (同じ囲みの中は 1 つのまとまり) と**近接** (枠の内側 < 枠と枠の間) の両方で示す。
   * 片方だけに頼らないのは、枠線が見えにくい環境でも間隔でまとまりが読めるようにするため。
   */
  const graph = (entry: GraphEntry) => {
    const block = element("section");
    block.style.border = `1px solid ${BORDER_COLOR}`;
    block.style.borderRadius = "8px";
    block.style.padding = `${INNER_PADDING}px`;
    block.style.margin = `${OUTER_GAP}px 0`;
    const heading = element("h4", entry.label);
    heading.style.margin = `0 0 ${INNER_GAP}px`;
    // 草を先に作る (送った後の取り直しを、草 → 概観の順にする)
    const grass = image(entry);
    // 草の下の 1 行に、概観と「共有する」の欄を並べる (#164)。草の幅の右側が空かないように
    const row = element("div");
    row.style.display = "flex";
    row.style.flexWrap = "wrap";
    row.style.alignItems = "center";
    row.style.gap = `${ROW_GAP}px`;
    row.style.marginTop = `${INNER_GAP}px`;
    row.append(overview(entry), share(entry));
    block.append(heading, grass, row);
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

  /** 見出しと本文の段落を持つ説明の 1 節 */
  const guideSection = (title: string, ...paragraphs: readonly (string | readonly string[])[]) => {
    const nodes: HTMLElement[] = [element("h4", title)];
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
   * 何をどう数えて描いているか (#164)。**畳んでおく** — 毎回読むものではないので、草を押し下げない。
   * 数値は実装に合わせる (sensor.ts の 3 分・20 秒、design §7 の四分位と 3 分のデッドゾーン、ADR-0021 の 4 軸)
   */
  const guide = () => {
    const details = element("details");
    const summary = element("summary", "草と活動の概観の見方");
    summary.style.cursor = "pointer";
    const privacy = element("p");
    privacy.append(
      "サーバに送るのは分ごとの記録と数 (編集したページ数など) だけで、ページ名・本文・リンク先は送りません。プロジェクト名もハッシュにして送ります。詳しくは",
      externalLink("プライバシーポリシー", PRIVACY_URL),
      "をご覧ください。",
    );
    details.append(
      summary,
      ...guideSection(
        "数えているもの",
        "1 日を 1 分ずつに区切り、分ごとに「書いた」か「読んだ」かだけを記録します。",
        [
          "書いた: その分に自分でページを編集した",
          "読んだ: 画面が見えていてフォーカスがあり、直近 3 分以内にスクロールやキー入力などの操作があった (20 秒ごとに確かめます)",
        ],
        "同じ分に両方あれば「書いた」に数えます。数えるのは、自分のページで cosense-grass を読み込んでいるプロジェクトだけです。",
      ),
      ...guideSection("草", "1 マスが 1 日、1 列が 1 週間です (直近 53 週)。", [
        "色の濃さ: その日の合計 (書いた分 + 読んだ分) を、これまでの全記録の分布 (四分位) で 4 段階に分けたもの。3 分未満の日は色を付けません",
        "色合い: その日が書き寄りか読み寄りか。自分のふだんの比率 (全記録の中央値) を真ん中にして、書き寄りの日ほどピンク、読み寄りの日ほど青になります (既定の配色)",
      ]),
      ...guideSection(
        "活動の概観",
        "草と同じ期間の分を、次の 4 つに分けた割合です。どの分も 1 つにしか数えません。",
        [
          "作る: その日に自分が新しく作ったページに書いた分",
          "育てる: 自分が前に作ったページに書いた分",
          "関わる: 他の人が作ったページに書いた分",
          "読む: 読んだだけの分",
        ],
        "書いたページがどれにあたるかは、そのページを最初に編集したときに、作成者と作成日を Cosense に問い合わせて決めます。図はいちばん多い軸が端まで伸び、ほかの軸はその何割かの長さです。% は合計が 100 になるよう丸めています。",
      ),
      ...guideSection("送るもの"),
      privacy,
    );
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

  const integrated = (view: IntegratedView, handlers: GraphDialogHandlers) => {
    const section = element("section");
    section.append(element("h3", "全端末を統合した記録"));
    if (view.kind === "message") {
      section.append(...view.lines.map((line) => element("p", line)), guide());
      return section;
    }
    section.append(
      element(
        "p",
        "同じ Google アカウントで登録した端末の記録をまとめた草です。ほかの人に見せる草は最大 15 分遅れて更新され、今日の列は日本時間で決まります。",
      ),
      guide(),
      graph(view.total),
      sync(view.sync, handlers),
    );

    if (view.projects.length === 0) {
      section.append(
        element("p", "このブラウザで直近 30 日に記録したプロジェクトはまだありません。"),
      );
      return section;
    }
    appendLimited(section, view.projects, graph);
    section.append(
      element(
        "p",
        "プロジェクト別に並ぶのは、このブラウザで直近 30 日に記録したプロジェクトです。ほかの端末だけで使っているプロジェクトは、そのプロジェクトを開いて記録すると並びます。",
      ),
    );
    return section;
  };

  return {
    open(view, handlers) {
      close();
      frames = [];
      const node = element("dialog");
      // 長い説明文で画面の幅いっぱいに広がらないよう、草の幅に余白を足したところで止める
      // 画面側の上限は既定 (`calc(100% - 6px - 2em)`) のまま。これより大きいと、余白と枠のぶん画面からはみ出す (#164)
      node.style.maxWidth = `min(${GRAPH_WIDTH + 80}px, calc(100% - 6px - 2em))`;
      for (const type of STOPPED_EVENTS) {
        node.addEventListener(type, (event) => event.stopPropagation());
      }
      node.addEventListener("close", () => {
        if (dialog === node) {
          close();
        }
      });
      closeOnBackdropClick(node, close);

      node.append(element("h2", MENU_TITLE), integrated(view, handlers), footer(handlers));

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
