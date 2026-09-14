/**
 * 「草を見る」のダイアログ (design §9「表示」、段階 8、Issue #73)。何を並べるかは `viewer.ts` が決める。
 *
 * - **ページに挿さずダイアログにする。** Cosense の遷移で消えないので、再マウントが要らない (ADR-0003 の改訂)
 * - **草は常にライトで出す。** 素の `<dialog>` は Cosense のどのテーマでも白地に黒 (research §3 の 2026-09-15 の実測)
 * - 全端末を統合した草は共有 SVG を `<img>` で見る (ADR-0003)。**このブラウザから送れていないプロジェクトは、押されるまで読まない**
 * - 文言は `textContent`、ハンドラは `addEventListener` (`sign-in-dialog.ts` と同じ約束。research §1)
 * - キー入力・貼り付け・コピーをダイアログの外へ伝えない (Cosense のショートカットとコピーの処理に拾わせない)
 * - **草の URL はコンソールにもログにも出さない** (publicId が分かると誰でも見られる)
 */
import { type GraphEntry, INITIAL_PROJECT_GRAPHS, type ViewModel } from "./viewer.ts";

const STOPPED_EVENTS = ["keydown", "keyup", "keypress", "paste", "copy", "cut"] as const;

/** 53 週の既定の SVG の寸法 (design §8)。先に確保して、読み込みでダイアログの大きさが変わらないようにする */
export const GRAPH_WIDTH = 775;
export const GRAPH_HEIGHT = 200;

export const DIALOG_TITLE = "cosense-grass: 草を見る";

export type GraphDialogDependencies = {
  /** `navigator.clipboard.writeText`。**クリックの処理から await を挟まずに呼ぶ** (Safari はユーザー操作の直後でないと拒む) */
  readonly writeText: (text: string) => Promise<void>;
};

export type GraphDialog = {
  open(model: ViewModel): void;
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

  const integrated = (model: Extract<ViewModel, { kind: "graphs" }>) => {
    const section = element("section");
    section.append(
      element("h3", "全端末を統合した記録"),
      element(
        "p",
        "同じ Google アカウントで登録した端末の記録をまとめた草です。最大 15 分遅れて更新され、今日の列は日本時間で決まります。",
      ),
      graph(model.total),
    );

    if (model.projects.length === 0) {
      section.append(
        element("p", "このブラウザで直近 30 日に記録したプロジェクトはまだありません。"),
      );
      return section;
    }
    const shown = model.projects.slice(0, INITIAL_PROJECT_GRAPHS);
    const rest = model.projects.slice(INITIAL_PROJECT_GRAPHS);
    section.append(...shown.map(graph));
    if (rest.length > 0) {
      const more = button(`ほか ${rest.length} 件を表示`, () => {
        more.replaceWith(...rest.map(graph));
      });
      section.append(more);
    }
    section.append(
      element(
        "p",
        "プロジェクト別に並ぶのは、このブラウザで直近 30 日に記録したプロジェクトです。ほかの端末だけで使っているプロジェクトは、そのプロジェクトを開いて記録すると並びます。",
      ),
    );
    return section;
  };

  return {
    open(model) {
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

      node.append(element("h2", DIALOG_TITLE));
      if (model.kind === "message") {
        node.append(...model.lines.map((line) => element("p", line)));
      } else {
        node.append(integrated(model));
      }
      const buttonLine = element("p");
      buttonLine.append(button("閉じる", close));
      node.append(buttonLine);

      doc.body.append(node);
      dialog = node;
      node.showModal();
    },

    close,
  };
}
