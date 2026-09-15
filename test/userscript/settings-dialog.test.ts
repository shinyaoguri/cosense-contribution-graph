import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SettingsModel } from "../../src/userscript/settings.ts";
import { COUNT_READ_LABEL, SETTINGS_DIALOG_TITLE } from "../../src/userscript/settings.ts";
import {
  createSettingsDialog,
  type SettingsDialogDependencies,
} from "../../src/userscript/settings-dialog.ts";

// jsdom 30 の <dialog> は open 属性しか無い。showModal と close を差し替える (graph-dialog.test.ts と同じ)
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

const PURGE = { label: "保存されているデータをすべて削除する", confirm: "削除しますか?" };

const ENROLLED: SettingsModel = {
  device: { kind: "enrolled", kid: "0123456789abcdef", lines: ["この端末は登録済みです。"] },
  countRead: { value: true, editable: true },
  signIn: { label: "サインインし直す" },
  revoke: { label: "この端末の登録を取り消す", confirm: "取り消しますか?" },
  purge: PURGE,
};

const NOT_ENROLLED: SettingsModel = {
  device: { kind: "not-enrolled", lines: ["この端末はまだ登録されていません。"] },
  countRead: { value: true, editable: true },
  signIn: { label: "サインインしてこの端末を登録" },
  purge: PURGE,
};

function setup(outcome: ReturnType<SettingsDialogDependencies["setCountRead"]> = "written") {
  const written: boolean[] = [];
  const signIns: number[] = [];
  const revokes: number[] = [];
  const revoke = { message: "取り消しました。", fails: false };
  const purges: number[] = [];
  const dialog = createSettingsDialog(document, {
    setCountRead: (value) => {
      written.push(value);
      return outcome;
    },
  });
  const open = (model: SettingsModel) => {
    dialog.open(model, {
      signIn: () => signIns.push(1),
      revoke: async () => {
        revokes.push(1);
        if (revoke.fails) {
          throw new Error("失効に失敗");
        }
        return revoke.message;
      },
      purge: async () => {
        purges.push(1);
        return "削除しました。";
      },
    });
  };
  const node = () => document.querySelector("dialog");
  const checkbox = () => node()?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  const button = (text: string) =>
    [...(node()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === text);
  /** 節 (h3 の文言で選ぶ) の中の状態表示。節ごとに 1 つある */
  const status = (heading: string) =>
    [...(node()?.querySelectorAll("section") ?? [])]
      .find((section) => section.querySelector("h3")?.textContent === heading)
      ?.querySelector('[role="status"]')?.textContent ?? "";
  return {
    dialog,
    written,
    signIns,
    revokes,
    revoke,
    purges,
    open,
    node,
    checkbox,
    button,
    status,
  };
}

describe("開く", () => {
  it("題と、この端末の状態と、閉じるボタンを出す", () => {
    const t = setup();

    t.open(ENROLLED);

    const text = t.node()?.textContent ?? "";
    expect(t.node()?.hasAttribute("open")).toBe(true);
    expect(text).toContain(SETTINGS_DIALOG_TITLE);
    expect(text).toContain("この端末は登録済みです。");
    expect(text).toContain("0123456789abcdef");
    expect(t.button("閉じる")).toBeDefined();
  });

  it("**押し直しても 1 枚しか残らない**", () => {
    const t = setup();

    t.open(ENROLLED);
    t.open(NOT_ENROLLED);

    expect(document.querySelectorAll("dialog")).toHaveLength(1);
    expect(t.node()?.textContent).toContain("まだ登録されていません");
  });

  it("閉じると DOM から消える", () => {
    const t = setup();

    t.open(ENROLLED);
    t.button("閉じる")?.click();

    expect(document.querySelector("dialog")).toBeNull();
  });

  it("**キー入力をダイアログの外へ伝えない** (Cosense のショートカットに拾わせない)", () => {
    const t = setup();
    const seen: string[] = [];
    document.body.addEventListener("keydown", () => seen.push("keydown"));

    t.open(ENROLLED);
    t.node()?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));

    expect(seen).toEqual([]);
  });
});

describe("サインイン", () => {
  it("**押すと、ダイアログを閉じてから始める** (サインインのダイアログと重ねない)", () => {
    const t = setup();

    t.open(NOT_ENROLLED);
    t.button("サインインしてこの端末を登録")?.click();

    expect(t.signIns).toEqual([1]);
    expect(document.querySelector("dialog")).toBeNull();
  });

  it("押しても直らない状態ではボタンを出さない", () => {
    const t = setup();

    t.open({
      device: { kind: "message", lines: ["保存領域を開けません。"] },
      countRead: { value: true, editable: true },
      purge: PURGE,
    });

    expect([...(t.node()?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
      PURGE.label,
      "閉じる",
    ]);
  });
});

describe("この端末の失効", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("**押しただけでは取り消さず、先に確かめる** (押し間違いで登録が飛ばない)", () => {
    const t = setup();

    t.open(ENROLLED);
    t.button("この端末の登録を取り消す")?.click();

    expect(t.revokes).toEqual([]);
    expect(t.node()?.textContent).toContain("取り消しますか?");
    expect(t.button("取り消す")).toBeDefined();
    expect(t.button("やめる")).toBeDefined();
  });

  it("確かめて「取り消す」を押すと実行し、結果を出す", async () => {
    const t = setup();

    t.open(ENROLLED);
    t.button("この端末の登録を取り消す")?.click();
    t.button("取り消す")?.click();
    await flush();

    expect(t.revokes).toEqual([1]);
    expect(t.status("この端末")).toContain("取り消しました。");
    expect(t.node()?.textContent).not.toContain("取り消しますか?");
  });

  it("「やめる」を押すと取り消さず、押し直せる", () => {
    const t = setup();

    t.open(ENROLLED);
    t.button("この端末の登録を取り消す")?.click();
    t.button("やめる")?.click();

    expect(t.revokes).toEqual([]);
    expect(t.node()?.textContent).not.toContain("取り消しますか?");
    expect(t.button("この端末の登録を取り消す")?.disabled).toBe(false);
  });

  it("例外になっても文言を出す (押しっぱなしに見せない)", async () => {
    const t = setup();
    t.revoke.fails = true;

    t.open(ENROLLED);
    t.button("この端末の登録を取り消す")?.click();
    t.button("取り消す")?.click();
    await flush();

    expect(t.status("この端末")).toContain("実行できませんでした");
  });

  it("登録が無ければボタンを出さない", () => {
    const t = setup();

    t.open(NOT_ENROLLED);

    expect(t.button("この端末の登録を取り消す")).toBeUndefined();
  });
});

describe("全データの削除", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("**押しただけでは消さず、先に確かめる**", () => {
    const t = setup();

    t.open(ENROLLED);
    t.button(PURGE.label)?.click();

    expect(t.purges).toEqual([]);
    expect(t.node()?.textContent).toContain(PURGE.confirm);
  });

  it("確かめて「削除する」を押すと実行し、結果を出す", async () => {
    const t = setup();

    t.open(ENROLLED);
    t.button(PURGE.label)?.click();
    t.button("削除する")?.click();
    await flush();

    expect(t.purges).toEqual([1]);
    expect(t.status("データの削除")).toContain("削除しました。");
  });

  it("**未登録でも出す** (このブラウザの記録は消せる)", () => {
    const t = setup();

    t.open(NOT_ENROLLED);

    expect(t.button(PURGE.label)).toBeDefined();
  });
});

describe("read 計上の on/off", () => {
  it("今の値をチェックボックスに出す", () => {
    const t = setup();

    t.open({ ...ENROLLED, countRead: { value: false, editable: true } });

    expect(t.checkbox()?.checked).toBe(false);
    expect(t.node()?.textContent).toContain(COUNT_READ_LABEL);
  });

  it("**外すと書きに行き、結果を知らせる**", () => {
    const t = setup();

    t.open(ENROLLED);
    const checkbox = t.checkbox();
    if (!checkbox) {
      throw new Error("チェックボックスが無い");
    }
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));

    expect(t.written).toEqual([false]);
    expect(t.status("数えるもの")).toContain("書いた時間だけを数えます");
  });

  it("**書けなければチェックを戻す** (設定と実際の動きを食い違わせない)", () => {
    const t = setup("failed");

    t.open(ENROLLED);
    const checkbox = t.checkbox();
    if (!checkbox) {
      throw new Error("チェックボックスが無い");
    }
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change"));

    expect(checkbox.checked).toBe(true);
    expect(t.status("数えるもの")).toContain("書けませんでした");
  });

  it("変えられないときは disabled にし、理由を出す", () => {
    const t = setup();

    t.open({
      ...ENROLLED,
      countRead: { value: false, editable: false, note: "新しい版が設定を書いています。" },
    });

    expect(t.checkbox()?.disabled).toBe(true);
    expect(t.node()?.textContent).toContain("新しい版が設定を書いています。");
  });
});
