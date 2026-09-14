/**
 * サインインのダイアログ (`SignInView` の DOM の実装)。段階 8 の設定 UI ができるまでの仮の置き場。
 *
 * - **文言は `textContent` で入れる。** innerHTML を使わない
 * - **ハンドラは `addEventListener`。** Cosense の CSP は `script-src-attr 'none'` で、属性のハンドラは動かない (research §1)
 * - `<dialog>` の `showModal` はページを inert にする。CSS は足さない (ブラウザの既定の見た目)
 * - キー入力と貼り付けをダイアログの外へ伝えない (Cosense のショートカットに拾わせない)
 */
import type { SignInView } from "./auth.ts";

const STOPPED_EVENTS = ["keydown", "keyup", "keypress", "paste"] as const;

export function createDialogView(doc: Document): SignInView {
  let dialog: HTMLDialogElement | undefined;
  let body: HTMLElement | undefined;
  let statusLine: HTMLElement | undefined;
  let controls: (HTMLInputElement | HTMLButtonElement)[] = [];
  /** 確認の途中で閉じられたら「いいえ」にする (でないと流れが止まったままになる) */
  let answer: ((value: boolean) => void) | undefined;

  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElement(tag);
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  };

  const close = () => {
    const current = dialog;
    if (current === undefined) {
      return;
    }
    // close イベントから cancel が呼ばれ、また close が呼ばれるので、先に外す
    dialog = undefined;
    body = undefined;
    statusLine = undefined;
    controls = [];
    answer?.(false);
    answer = undefined;
    if (current.open) {
      current.close();
    }
    current.remove();
  };

  const closeButton = () => {
    const button = element("button", "閉じる");
    button.type = "button";
    button.addEventListener("click", close);
    return button;
  };

  return {
    open(state, handlers) {
      close();
      const node = element("dialog");
      for (const type of STOPPED_EVENTS) {
        node.addEventListener(type, (event) => event.stopPropagation());
      }
      // Esc で閉じたときも、やめるとして扱う。こちらから閉じたとき (close() の後) は呼ばない
      node.addEventListener("close", () => {
        if (dialog === node) {
          handlers.cancel();
        }
      });

      const content = element("div");
      content.append(
        element("h2", "cosense-grass: この端末を登録"),
        element(
          "p",
          state.popupBlocked
            ? "ポップアップを開けませんでした。ブラウザでポップアップを許可してメニューをもう一度押すか、下のリンクでサインインして、表示されたコードを貼ってください。"
            : "ポップアップで Google にサインインしてください。終わると自動で登録します。",
        ),
        element(
          "p",
          "ポップアップが閉じても進まないときは、サインインの画面に出たコードを貼ってください。自分でサインインして出たコードだけを貼ってください。",
        ),
      );

      const link = element("a", "別のタブでサインインを開く");
      link.href = state.startUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const linkLine = element("p");
      linkLine.append(link);

      const form = element("form");
      const input = element("input");
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      // 狭い画面でもダイアログからはみ出さない (style 属性は Cosense の CSP で許されている。research §1)
      input.style.width = "100%";
      input.style.boxSizing = "border-box";
      input.setAttribute("aria-label", "サインインの画面に出たコード");
      const submit = element("button", "登録");
      submit.type = "submit";
      const cancel = element("button", "やめる");
      cancel.type = "button";
      cancel.addEventListener("click", () => handlers.cancel());
      form.append(input, " ", submit, " ", cancel);
      form.addEventListener("submit", (event) => {
        // 送信 (ナビゲーション) させない
        event.preventDefault();
        handlers.submit(input.value);
      });

      const status = element("p");
      status.setAttribute("role", "status");

      content.append(linkLine, form, status);
      node.append(content);
      doc.body.append(node);
      dialog = node;
      body = content;
      statusLine = status;
      controls = [input, submit];
      node.showModal();
      input.focus();
    },

    status(text) {
      if (statusLine !== undefined) {
        statusLine.textContent = text;
      }
    },

    busy(on) {
      for (const control of controls) {
        control.disabled = on;
      }
      if (on && statusLine !== undefined) {
        statusLine.textContent = "登録しています…";
      }
    },

    confirm(text) {
      const content = body;
      if (content === undefined) {
        return Promise.resolve(false);
      }
      return new Promise((settle) => {
        const resolve = (value: boolean) => {
          answer = undefined;
          settle(value);
        };
        answer = resolve;
        const yes = element("button", "登録し直す");
        const no = element("button", "やめる");
        yes.type = "button";
        no.type = "button";
        const line = element("p");
        line.append(yes, " ", no);
        const question = element("p", text);
        yes.addEventListener("click", () => {
          question.remove();
          line.remove();
          resolve(true);
        });
        no.addEventListener("click", () => resolve(false));
        content.append(question, line);
      });
    },

    finish(lines, link) {
      const content = body;
      if (content === undefined) {
        return;
      }
      content.replaceChildren(element("h2", "cosense-grass: この端末を登録"));
      for (const line of lines) {
        content.append(element("p", line));
      }
      if (link !== undefined) {
        const anchor = element("a", link);
        anchor.href = link;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        const line = element("p");
        line.append(anchor);
        content.append(line);
      }
      const buttonLine = element("p");
      buttonLine.append(closeButton());
      content.append(buttonLine);
    },

    close,
  };
}
