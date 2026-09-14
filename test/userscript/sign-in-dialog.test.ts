import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDialogView } from "../../src/userscript/sign-in-dialog.ts";

// jsdom 30 の <dialog> は open 属性しか無い。showModal と close を差し替える
const prototype = HTMLDialogElement.prototype as HTMLDialogElement & {
  showModal?: () => void;
  close?: () => void;
};
const original = { showModal: prototype.showModal, close: prototype.close };

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
});

function openView(popupBlocked = false) {
  const view = createDialogView(document);
  const calls = { submits: [] as string[], cancels: 0 };
  view.open(
    { popupBlocked, startUrl: "https://grass.soui.dev/auth/start" },
    {
      submit: (text) => calls.submits.push(text),
      cancel: () => {
        calls.cancels++;
        view.close();
      },
    },
  );
  const dialog = document.querySelector("dialog");
  if (!dialog) {
    throw new Error("dialog が無い");
  }
  return { view, calls, dialog };
}

describe("createDialogView", () => {
  it("開くとモーダルで、別のタブのリンクは opener も Referer も渡さない", () => {
    const { dialog } = openView();
    expect(dialog.open).toBe(true);
    const link = dialog.querySelector("a");
    expect(link?.href).toBe("https://grass.soui.dev/auth/start");
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener noreferrer");
  });

  it("ポップアップがブロックされたときはその旨を出す", () => {
    const { dialog } = openView(true);
    expect(dialog.textContent).toContain("ポップアップを開けませんでした");
  });

  it("**送信はナビゲーションさせず、入力を渡す**", () => {
    const { dialog, calls } = openView();
    const input = dialog.querySelector("input");
    const form = dialog.querySelector("form");
    if (!input || !form) {
      throw new Error("入力欄が無い");
    }
    input.value = "pasted-code";
    const event = new Event("submit", { cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(calls.submits).toEqual(["pasted-code"]);
  });

  it("**文言は HTML として解釈しない**", async () => {
    const { view, dialog } = openView();
    view.status('<img src=x onerror="alert(1)">');
    view.finish(
      ["<b>太字</b>"],
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg",
    );
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.querySelector("b")).toBeNull();
    expect(dialog.textContent).toContain("<b>太字</b>");
    expect(dialog.querySelector("a")?.textContent).toBe(
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg",
    );
  });

  it("やめるボタンと Esc (close イベント) はやめるとして扱い、DOM から消す", () => {
    const first = openView();
    const cancel = [...first.dialog.querySelectorAll("button")].find(
      (b) => b.textContent === "やめる",
    );
    cancel?.click();
    expect(first.calls.cancels).toBe(1);
    expect(document.querySelector("dialog")).toBeNull();

    const second = openView();
    second.dialog.dispatchEvent(new Event("close"));
    expect(second.calls.cancels).toBe(1);
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("**キー入力と貼り付けを Cosense に伝えない**", () => {
    const { dialog } = openView();
    const seen: string[] = [];
    for (const type of ["keydown", "keyup", "keypress", "paste"]) {
      document.body.addEventListener(type, () => seen.push(type));
      dialog.querySelector("input")?.dispatchEvent(new Event(type, { bubbles: true }));
    }
    expect(seen).toEqual([]);
  });

  it("busy の間は入力できない", () => {
    const { view, dialog } = openView();
    view.busy(true);
    expect(dialog.querySelector("input")?.disabled).toBe(true);
    view.busy(false);
    expect(dialog.querySelector("input")?.disabled).toBe(false);
  });

  it("確認はボタンで答える", async () => {
    const { view, dialog } = openView();
    const answer = view.confirm("置き換えますか");
    [...dialog.querySelectorAll("button")].find((b) => b.textContent === "登録し直す")?.click();
    expect(await answer).toBe(true);
  });

  it("**確認の途中で閉じられたら「いいえ」にする** (流れを止めたままにしない)", async () => {
    const { view, dialog } = openView();
    const answer = view.confirm("置き換えますか");
    dialog.dispatchEvent(new Event("close"));
    expect(await answer).toBe(false);
  });

  it("閉じた後の表示は何もしない", () => {
    const { view } = openView();
    view.close();
    expect(() => {
      view.status("x");
      view.busy(true);
      view.finish(["x"]);
      view.close();
    }).not.toThrow();
    expect(document.querySelector("dialog")).toBeNull();
  });
});
