/**
 * 草のダイアログ (design §9「表示」、段階 8、Issue #73)。何を並べるかは `viewer.ts` が決める。
 *
 * - **ページに挿さずダイアログにする。** Cosense の遷移で消えないので、再マウントが要らない (ADR-0003 の改訂)
 * - **草は常にライトで出す。** 素の `<dialog>` は Cosense のどのテーマでも白地に黒 (research §3 の 2026-09-15 の実測)
 * - **出すのは Worker が作った共有 SVG の `<img>` だけ** (ADR-0019、Issue #109)。ここは草を描かない。
 *   **このブラウザから送れていないものは、押されるまで読まない**
 * - 文言は `textContent`、ハンドラは `addEventListener` (`sign-in-dialog.ts` と同じ約束。research §1)
 * - キー入力・貼り付け・コピーをダイアログの外へ伝えない (Cosense のショートカットとコピーの処理に拾わせない)
 * - **同期の状態と「今すぐ送る」を合算の草の直後に置く** (Issue #102)。押した後は
 *   **ダイアログを開き直さず、状態行と表示中の画像だけ差し替える** (開き直すと畳みが戻り、画像を全部取り直す)
 * - **草の URL はコンソールにもログにも出さない** (publicId が分かると誰でも見られる)
 * - **「設定」はここから開く** (Issue #95)。ページメニューはこのダイアログの 1 項目だけにしたので、
 *   設定への入口はここが唯一。サインインは設定のダイアログの中のクリックで始まるので、
 *   ポップアップを開く同期区間は分断されない
 */
import { MENU_TITLE, SETTINGS_LABEL } from "./settings.ts";
import {
  type GraphEntry,
  INITIAL_PROJECT_GRAPHS,
  type IntegratedView,
  SEND_NOW_LABEL,
  type SyncView,
} from "./viewer.ts";

const STOPPED_EVENTS = ["keydown", "keyup", "keypress", "paste", "copy", "cut"] as const;

/** 53 週の既定の SVG の寸法 (design §8)。先に確保して、読み込みでダイアログの大きさが変わらないようにする */
export const GRAPH_WIDTH = 775;
export const GRAPH_HEIGHT = 200;

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
  let frames: { entry: GraphEntry; frame: HTMLElement }[] = [];

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

  const imageElement = (entry: GraphEntry, lazy: boolean) => {
    const img = element("img");
    img.width = GRAPH_WIDTH;
    img.height = GRAPH_HEIGHT;
    img.alt = `${entry.label} の草`;
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
   */
  const srcOf = (entry: GraphEntry, bust?: number) =>
    bust === undefined ? entry.url : `${entry.url}?r=${bust}`;

  /** 草の画像。読めなければ文言に置き換える (送れているのに読めないのは、サーバに届かないとき) */
  const image = (entry: GraphEntry) => {
    const frame = element("div");
    // 狭い画面では横にスクロールする (style 属性は Cosense の CSP で許されている。research §1)
    frame.style.overflowX = "auto";
    const img = imageElement(entry, true);
    img.addEventListener("error", () => {
      frame.replaceChildren(
        element(
          "p",
          "草を表示できませんでした (サーバに届かないか、まだ記録が反映されていません)。",
        ),
      );
    });
    img.src = srcOf(entry);
    frame.append(img);
    frames.push({ entry, frame });
    return frame;
  };

  /**
   * 送った後に、表示中の草を取り直す。**新しい絵が読めてから差し替える** —
   * 取り直しが失敗したときに、見えていた草が文言に化けないようにする。
   */
  const refreshGraphs = () => {
    const bust = Date.now();
    for (const { entry, frame } of frames) {
      const next = imageElement(entry, false);
      next.addEventListener("load", () => {
        frame.replaceChildren(next);
      });
      next.src = srcOf(entry, bust);
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

  const copyLine = (entry: GraphEntry) => {
    const line = element("p");
    const status = element("span");
    status.setAttribute("role", "status");
    let field: HTMLInputElement | undefined;
    const copy = button("URL をコピー", () => {
      // await を挟まずに呼ぶ。結果は後から書く
      deps.writeText(entry.url).then(
        () => {
          status.textContent = " コピーしました";
        },
        () => {
          // コピーできなければ、選んでコピーできる欄に出す (押し直しても欄は 1 つ)
          if (field === undefined) {
            field = element("input");
            field.type = "text";
            field.readOnly = true;
            field.value = entry.url;
            field.style.width = "100%";
            field.style.boxSizing = "border-box";
            field.setAttribute("aria-label", `${entry.label} の草の URL`);
            line.after(field);
          }
          status.textContent = " コピーできなかったので、下の欄から選んでコピーしてください";
          field.select();
        },
      );
    });
    line.append(copy, status);
    return line;
  };

  const graph = (entry: GraphEntry) => {
    const block = element("div");
    block.append(element("h4", entry.label));
    if (entry.sent) {
      block.append(image(entry));
    } else {
      const note = element("p", "このブラウザからはまだ送っていません。 ");
      note.append(
        button("表示してみる", () => {
          // ほかの端末から送っていれば草はある
          note.replaceWith(image(entry));
        }),
      );
      block.append(note);
    }
    block.append(copyLine(entry));
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

  const integrated = (view: IntegratedView, handlers: GraphDialogHandlers) => {
    const section = element("section");
    section.append(element("h3", "全端末を統合した記録"));
    if (view.kind === "message") {
      section.append(...view.lines.map((line) => element("p", line)));
      return section;
    }
    section.append(
      element(
        "p",
        "同じ Google アカウントで登録した端末の記録をまとめた草です。ほかの人に見せる草は最大 15 分遅れて更新され、今日の列は日本時間で決まります。",
      ),
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
      node.style.maxWidth = `min(${GRAPH_WIDTH + 80}px, calc(100% - 34px))`;
      for (const type of STOPPED_EVENTS) {
        node.addEventListener(type, (event) => event.stopPropagation());
      }
      node.addEventListener("close", () => {
        if (dialog === node) {
          close();
        }
      });

      node.append(element("h2", MENU_TITLE), integrated(view, handlers));
      const buttonLine = element("p");
      buttonLine.append(
        button("閉じる", close),
        doc.createTextNode(" "),
        // 閉じてから開く。設定のダイアログは自分で状況を読み直す
        button(SETTINGS_LABEL, () => {
          close();
          handlers.openSettings();
        }),
      );
      node.append(buttonLine);

      doc.body.append(node);
      dialog = node;
      node.showModal();
    },

    close,
  };
}
