/**
 * 「設定」のダイアログ (design §9「設定 UI」、段階 8、Issue #79)。何を出すかは `settings.ts` が決める。
 *
 * - **ページに挿さずダイアログにする** (ADR-0003 の 2026-09-15 の改訂。`graph-dialog.ts` と同じ)
 * - 文言は `textContent`、ハンドラは `addEventListener` (Cosense の CSP。research §1)
 * - キー入力・貼り付け・コピーをダイアログの外へ伝えない (Cosense のショートカットに拾わせない)
 * - **サインインはクリックの同期区間で始める。** `await` を挟むとポップアップがブロックされる (design §3)。
 *   先にこのダイアログを閉じてから呼ぶ (サインインのダイアログと重ねない)。
 *   始め方は開くたびに渡す (`sign-in-dialog.ts` と同じ handlers の形)
 */
import {
  CLEAR_NOTE,
  COUNT_READ_LABEL,
  COUNT_READ_NOTE,
  type DangerAction,
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
  /** この端末の登録を取り消す。返した文言をそのまま出す */
  revoke(): Promise<string>;
  /** このブラウザの記録を消す。返した文言をそのまま出す */
  clear(): Promise<string>;
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
    if (model.revoke) {
      section.append(danger(model.revoke, handlers.revoke, "取り消す"));
    }
    // ほかの端末は Worker のページで扱う (CSP で一覧をここに出せない。ADR-0017)
    const line = element("p");
    const link = element("a", model.devices.label);
    link.href = model.devices.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    line.append(link);
    section.append(line);
    return section;
  };

  const clear = (model: SettingsModel, handlers: SettingsHandlers) => {
    const section = element("section");
    section.append(element("h3", "このブラウザの記録"));
    section.append(danger(model.clear, handlers.clear, "消す"));
    section.append(element("p", CLEAR_NOTE));
    return section;
  };

  /** 押すと確かめてから実行する。**確認を挟まずに消さない** (押し間違いでデータが飛ぶ) */
  const danger = (
    { label, confirm }: DangerAction,
    run: () => Promise<string>,
    yesLabel: string,
  ) => {
    const line = element("p");
    const status = element("span");
    status.setAttribute("role", "status");
    const start = button(label, () => {
      const question = element("span", ` ${confirm} `);
      const yes = button(yesLabel, () => {
        yes.disabled = true;
        no.disabled = true;
        status.textContent = " 実行しています…";
        run().then(
          (message) => {
            question.remove();
            status.textContent = ` ${message}`;
          },
          () => {
            question.remove();
            status.textContent = " 実行できませんでした。ページを開き直してやり直してください。";
          },
        );
      });
      const no = button("やめる", () => {
        question.remove();
        start.disabled = false;
      });
      question.append(yes, no);
      start.disabled = true;
      start.after(question);
    });
    line.append(start, status);
    return line;
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

      node.append(
        element("h2", SETTINGS_DIALOG_TITLE),
        device(model, handlers),
        countRead(model),
        clear(model, handlers),
      );
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
