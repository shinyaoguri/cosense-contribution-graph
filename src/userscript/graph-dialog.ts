/**
 * 「草を見る」のダイアログ (design §9「表示」、段階 8、Issue #73)。何を並べるかは `viewer.ts` が決める。
 *
 * - **ページに挿さずダイアログにする。** Cosense の遷移で消えないので、再マウントが要らない (ADR-0003 の改訂)
 * - **草は常にライトで出す。** 素の `<dialog>` は Cosense のどのテーマでも白地に黒 (research §3 の 2026-09-15 の実測)
 * - 全端末を統合した草は共有 SVG を `<img>` で見る (ADR-0003)。**このブラウザから送れていないプロジェクトは、押されるまで読まない**
 * - このブラウザの記録は `render.ts` で DOM の SVG にし、マスにツールチップを付ける。統合の方が未登録でも出す
 * - 文言は `textContent`、ハンドラは `addEventListener` (`sign-in-dialog.ts` と同じ約束。research §1)
 * - キー入力・貼り付け・コピーをダイアログの外へ伝えない (Cosense のショートカットとコピーの処理に拾わせない)
 * - **草の URL はコンソールにもログにも出さない** (publicId が分かると誰でも見られる)
 * - **「草の設定」はここから開く** (Issue #95)。ページメニューはこのダイアログの 1 項目だけにしたので、
 *   設定への入口はここが唯一。サインインは設定のダイアログの中のクリックで始まるので、
 *   ポップアップを開く同期区間は分断されない
 */
import { layoutGraph } from "../shared/graph-layout.ts";
import { renderGraphElement } from "./render.ts";
import { SETTINGS_LABEL } from "./settings.ts";
import {
  type GraphEntry,
  INITIAL_PROJECT_GRAPHS,
  type IntegratedView,
  type LocalGraph,
  type LocalView,
  tooltipOf,
  type ViewModel,
} from "./viewer.ts";

const STOPPED_EVENTS = ["keydown", "keyup", "keypress", "paste", "copy", "cut"] as const;

/** 53 週の既定の SVG の寸法 (design §8)。先に確保して、読み込みでダイアログの大きさが変わらないようにする */
export const GRAPH_WIDTH = 775;
export const GRAPH_HEIGHT = 200;

export const DIALOG_TITLE = "cosense-grass: 草を見る";

/** このブラウザの記録のうち、プロジェクト別の草の倍率 (design §9「プロジェクト別の草を小さく並べる」) */
export const LOCAL_PROJECT_SCALE = 0.6;

export type GraphDialogDependencies = {
  /** `navigator.clipboard.writeText`。**クリックの処理から await を挟まずに呼ぶ** (Safari はユーザー操作の直後でないと拒む) */
  readonly writeText: (text: string) => Promise<void>;
};

export type GraphDialogHandlers = {
  /** 「草の設定」を開く。**このダイアログを閉じてから呼ばれる** (2 枚重ねない) */
  openSettings(): void;
};

export type GraphDialog = {
  open(model: ViewModel, handlers: GraphDialogHandlers): void;
  close(): void;
};

export function createGraphDialog(doc: Document, deps: GraphDialogDependencies): GraphDialog {
  let dialog: HTMLDialogElement | undefined;

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

  /** 草の画像。読めなければ文言に置き換える (送れているのに読めないのは、サーバに届かないとき) */
  const image = (entry: GraphEntry) => {
    const frame = element("div");
    // 狭い画面では横にスクロールする (style 属性は Cosense の CSP で許されている。research §1)
    frame.style.overflowX = "auto";
    const img = element("img");
    img.width = GRAPH_WIDTH;
    img.height = GRAPH_HEIGHT;
    img.alt = `${entry.label} の草`;
    // 属性で付ける (jsdom は loading の IDL 属性を持たない)
    img.setAttribute("loading", "lazy");
    img.setAttribute("referrerpolicy", "no-referrer");
    img.style.maxWidth = "none";
    img.addEventListener("error", () => {
      frame.replaceChildren(
        element(
          "p",
          "草を表示できませんでした (サーバに届かないか、まだ記録が反映されていません)。",
        ),
      );
    });
    img.src = entry.url;
    frame.append(img);
    return frame;
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

  const integrated = (view: IntegratedView) => {
    const section = element("section");
    section.append(element("h3", "全端末を統合した記録"));
    if (view.kind === "message") {
      section.append(...view.lines.map((line) => element("p", line)));
      return section;
    }
    section.append(
      element(
        "p",
        "同じ Google アカウントで登録した端末の記録をまとめた草です。最大 15 分遅れて更新され、今日の列は日本時間で決まります。",
      ),
      graph(view.total),
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

  const localGraph = (entry: LocalGraph, scale: number) => {
    const block = element("div");
    const frame = element("div");
    frame.style.overflowX = "auto";
    frame.append(
      renderGraphElement(doc, layoutGraph(entry.input), {
        scale,
        label: `${entry.label} の草`,
        tooltip: (day) => tooltipOf(day, entry.counts.get(day)),
      }),
    );
    block.append(element("h4", entry.label), frame);
    return block;
  };

  const local = (view: LocalView) => {
    const section = element("section");
    section.append(
      element("h3", "このブラウザの記録"),
      element(
        "p",
        "このブラウザで数えた記録から描いた草です。ほかの端末の記録は含みません。マスにカーソルを載せると、その日の分数とページ数が出ます。",
      ),
      localGraph(view.total, 1),
    );
    if (view.projects.length === 0) {
      section.append(element("p", "このブラウザで数えたプロジェクトはまだありません。"));
      return section;
    }
    appendLimited(section, view.projects, (entry) => localGraph(entry, LOCAL_PROJECT_SCALE));
    return section;
  };

  return {
    open(model, handlers) {
      close();
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

      node.append(element("h2", DIALOG_TITLE), integrated(model.integrated), local(model.local));
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
