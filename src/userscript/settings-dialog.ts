/**
 * 「草の設定」のダイアログ (design §9「設定 UI」、段階 8、Issue #79)。何を出すかは `settings.ts` が決める。
 *
 * - **ページに挿さずダイアログにする** (ADR-0003 の 2026-09-15 の改訂。`graph-dialog.ts` と同じ)
 * - 文言は `textContent`、ハンドラは `addEventListener` (Cosense の CSP。research §1)
 * - キー入力・貼り付け・コピーをダイアログの外へ伝えない (Cosense のショートカットに拾わせない)
 * - **サインインはクリックの同期区間で始める。** `await` を挟むとポップアップがブロックされる (design §3)。
 *   先にこのダイアログを閉じてから呼ぶ (サインインのダイアログと重ねない)。
 *   始め方は開くたびに渡す (`sign-in-dialog.ts` と同じ handlers の形)
 */
import {
  COUNT_READ_LABEL,
  COUNT_READ_NOTE,
  SETTINGS_DIALOG_TITLE,
  type SettingsModel,
} from "./settings.ts";

const STOPPED_EVENTS = ["keydown", "keyup", "keypress", "paste", "copy", "cut"] as const;

export type SettingsDialogDependencies = {
  /** 読みを数えるかを書く。書けたかどうかを返す */
  readonly setCountRead: (value: boolean) => "written" | "blocked" | "failed";
};

export type SettingsHandlers = {
  /** サインインを始める。**押した同期区間で呼ばれる** */
  signIn(): void;
};

export type SettingsDialog = {
  open(model: SettingsModel, handlers: SettingsHandlers): void;
  close(): void;
};

const WRITE_FAILURE_TEXT: Record<"blocked" | "failed", string> = {
  blocked: " 新しい版の cosense-grass が設定を書いているので、この版からは変えられませんでした。",
  failed: " このブラウザの保存領域に書けませんでした。",
};

export function createSettingsDialog(
  doc: Document,
  deps: SettingsDialogDependencies,
): SettingsDialog {
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

  const device = (model: SettingsModel, handlers: SettingsHandlers) => {
    const section = element("section");
    section.append(element("h3", "この端末"));
    section.append(...model.device.lines.map((line) => element("p", line)));
    if (model.device.kind === "enrolled") {
      section.append(element("p", `端末の識別子: ${model.device.kid}`));
    }
    if (model.signIn) {
      const line = element("p");
      line.append(
        button(model.signIn.label, () => {
          // 閉じてから始める。どちらも同期なので、ポップアップはクリックの直後に開く
          close();
          handlers.signIn();
        }),
      );
      section.append(line);
    }
    return section;
  };

  const countRead = (model: SettingsModel) => {
    const section = element("section");
    const line = element("p");
    const label = element("label");
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.checked = model.countRead.value;
    checkbox.disabled = !model.countRead.editable;
    const status = element("span");
    status.setAttribute("role", "status");
    checkbox.addEventListener("change", () => {
      const value = checkbox.checked;
      const outcome = deps.setCountRead(value);
      if (outcome === "written") {
        status.textContent = value ? " 読んだ時間も数えます" : " 書いた時間だけを数えます";
        return;
      }
      // 書けていないので、チェックを戻して食い違わせない
      checkbox.checked = !value;
      status.textContent = WRITE_FAILURE_TEXT[outcome];
    });
    label.append(checkbox, doc.createTextNode(` ${COUNT_READ_LABEL}`));
    line.append(label, status);
    section.append(element("h3", "数えるもの"), line, element("p", COUNT_READ_NOTE));
    if (model.countRead.note) {
      section.append(element("p", model.countRead.note));
    }
    return section;
  };

  return {
    open(model, handlers) {
      close();
      const node = element("dialog");
      node.style.maxWidth = "min(640px, calc(100% - 34px))";
      for (const type of STOPPED_EVENTS) {
        node.addEventListener(type, (event) => event.stopPropagation());
      }
      node.addEventListener("close", () => {
        if (dialog === node) {
          close();
        }
      });

      node.append(element("h2", SETTINGS_DIALOG_TITLE), device(model, handlers), countRead(model));
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
