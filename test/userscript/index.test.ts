import { describe, expect, it } from "vitest";
import { CLEAR_TEXT, type ClearResult } from "../../src/userscript/cleaner.ts";
import type { GraphDialogHandlers } from "../../src/userscript/graph-dialog.ts";
import { type Cosense, type Dependencies, start } from "../../src/userscript/index.ts";
import { SEND_TEXT, type SendOutcome } from "../../src/userscript/outbox.ts";
import { REVOKE_TEXT, type RevokeOutcome } from "../../src/userscript/revoke.ts";
import type { SendStatus } from "../../src/userscript/sender.ts";
import type { CountingStatus } from "../../src/userscript/sensor.ts";
import type { SettingsModel } from "../../src/userscript/settings.ts";
import { MENU_TITLE } from "../../src/userscript/settings.ts";
import type { SettingsHandlers } from "../../src/userscript/settings-dialog.ts";
import { readSettings } from "../../src/userscript/settings-store.ts";
import type { IntegratedView } from "../../src/userscript/viewer.ts";

/** 偽の Cosense と依存。開いたダイアログ・localStorage・イベントを記録する。 */
function setup(projectName = "project-a") {
  const clock = { ms: Date.parse("2026-09-13T06:00:00Z") };
  const items: { title: string; onClick: () => void }[] = [];
  const store = new Map<string, string>();
  const listeners: (() => void)[] = [];
  const doc = { visibilityState: "visible" as DocumentVisibilityState };

  const project = { name: projectName };
  const sensor = { started: 0, status: "counting" as CountingStatus };
  const cosense: Cosense = {
    Project: project,
    Page: { id: null },
    Layout: "page",
    on: () => undefined,
    off: () => undefined,
    PageMenu: { addItem: (item) => items.push(item) },
  };
  const signIns = { count: 0, outcome: "added" };
  const revokes = { count: 0, outcome: "revoked" as RevokeOutcome };
  const clears = { count: 0, outcome: "cleared" as ClearResult };
  const triggers: string[] = [];
  const views: { view: IntegratedView; handlers: GraphDialogHandlers }[] = [];
  const settingsViews: { model: SettingsModel; handlers: SettingsHandlers }[] = [];
  const sending = {
    count: 0,
    outcome: "nothing" as SendOutcome,
    status: async (): Promise<SendStatus> => ({ kind: "not-enrolled" }),
  };
  const deps: Dependencies = {
    signIn: () => {
      signIns.count++;
      return Promise.resolve(signIns.outcome);
    },
    sender: {
      trigger: async (kind) => {
        triggers.push(kind);
        return sending.outcome;
      },
      status: () => {
        sending.count++;
        return sending.status();
      },
    },
    graphDialog: { open: (view, handlers) => views.push({ view, handlers }) },
    revoker: {
      revokeThisDevice: async () => {
        revokes.count++;
        return revokes.outcome;
      },
    },
    cleaner: {
      clearLocalRecords: () => {
        clears.count++;
        return clears.outcome;
      },
    },
    settingsDialog: {
      open: (model, handlers) => settingsViews.push({ model, handlers }),
    },
    settings: {
      read: () => readSettings({ getItem: (key) => store.get(key) ?? null }),
    },
    startSensor: () => {
      sensor.started++;
      return { stop: () => undefined, status: () => sensor.status };
    },
    document: {
      get visibilityState() {
        return doc.visibilityState;
      },
      addEventListener: (type: string, listener: () => void) => {
        if (type === "visibilitychange") {
          listeners.push(listener);
        }
      },
    } as Dependencies["document"],
    now: () => new Date(clock.ms),
  };

  /** 表示状態を変えてイベントを発火する。送信の完了まで待つ。 */
  async function setVisibility(state: DocumentVisibilityState) {
    doc.visibilityState = state;
    for (const listener of listeners) {
      listener();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function clickMenu(title = MENU_TITLE) {
    const item = items.find((i) => i.title === title);
    if (!item) {
      throw new Error("メニューが無い");
    }
    item.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** 「草を見る」を開き、そのダイアログの「草の設定」を押す (ページメニューからは開けない) */
  async function openSettings() {
    await clickMenu(MENU_TITLE);
    views[views.length - 1]?.handlers.openSettings();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return {
    cosense,
    deps,
    clock,
    items,
    store,
    sensor,
    project,
    setVisibility,
    clickMenu,
    openSettings,
    signIns,
    triggers,
    views,
    settingsViews,
    revokes,
    clears,
    sending,
  };
}

describe("ページメニュー", () => {
  it("**足すのは「草を見る」の 1 項目だけ** (Cosense のページメニューの占有を最小にする)", () => {
    const t = setup();

    start(t.cosense, t.deps);

    expect(t.items.map((i) => i.title)).toEqual([MENU_TITLE]);
  });
});

describe("草の設定", () => {
  it("**「草を見る」のダイアログから開く**。開くたびに登録の状態と設定を読み直す", async () => {
    const t = setup();
    start(t.cosense, t.deps);

    await t.openSettings();
    await t.openSettings();

    expect(t.settingsViews).toHaveLength(2);
    expect(t.settingsViews[0]?.model.device.kind).toBe("not-enrolled");
    // 草のダイアログと設定のダイアログが、それぞれ開くたびに読み直す
    expect(t.sending.count).toBe(4);
  });

  it("**サインインは「草の設定」の handlers から 1 回だけ呼ぶ** (ポップアップを開くのにクリックの直後である必要がある)", async () => {
    const t = setup();
    start(t.cosense, t.deps);

    await t.openSettings();
    t.settingsViews[0]?.handlers.signIn();

    expect(t.signIns.count).toBe(1);
  });
});

describe("草を見る", () => {
  it("**押すたびに送信の状況を読み直し**、今のプロジェクトを先頭にしてダイアログを開く", async () => {
    const t = setup("b");
    t.sending.status = async () => ({
      kind: "enrolled",
      kid: "0123456789abcdef",
      graphUrl: "https://grass.soui.dev/v1/g/total.svg",
      totalSent: true,
      projects: [
        { name: "a", graphUrl: "https://grass.soui.dev/v1/g/a.svg", sent: true },
        { name: "b", graphUrl: "https://grass.soui.dev/v1/g/b.svg", sent: false },
      ],
      todaySends: 0,
      pendingPastDays: 0,
      todayPending: false,
    });
    start(t.cosense, t.deps);

    await t.clickMenu(MENU_TITLE);
    await t.clickMenu(MENU_TITLE);

    expect(t.sending.count).toBe(2);
    expect(t.views).toHaveLength(2);
    const view = t.views[0]?.view;
    expect(view?.kind === "graphs" && view.projects.map((project) => project.url)).toEqual([
      "https://grass.soui.dev/v1/g/b.svg",
      "https://grass.soui.dev/v1/g/a.svg",
    ]);
    // 送信はしない (読み込み時の 1 回だけ)
    expect(t.triggers).toEqual(["load"]);
  });

  it("**「今すぐ送る」は manual で送り、結果の文言と読み直した状態を返す** (Issue #102)", async () => {
    const t = setup("b");
    t.sending.outcome = "written";
    t.sending.status = async () => ({
      kind: "enrolled",
      kid: "0123456789abcdef",
      graphUrl: "https://grass.soui.dev/v1/g/total.svg",
      totalSent: true,
      projects: [],
      todaySends: 1,
      pendingPastDays: 0,
      todayPending: false,
    });
    start(t.cosense, t.deps);
    await t.clickMenu(MENU_TITLE);

    const result = await t.views[0]?.handlers.sendNow();

    expect(t.triggers).toEqual(["load", "manual"]);
    expect(result?.text).toBe(SEND_TEXT.written);
    // 送れたので、表示中の草を取り直してよい
    expect(result?.refresh).toBe(true);
    expect(result?.view.lines[0]).toBe("このブラウザの記録は送信済みです。");
    // 押した後にもう一度状況を読む (ダイアログは開き直さない)
    expect(t.sending.count).toBe(2);
  });

  it("**サーバの記録が変わらなければ草を取り直さない**", async () => {
    const t = setup("b");
    t.sending.outcome = "nothing";
    start(t.cosense, t.deps);
    await t.clickMenu(MENU_TITLE);

    const result = await t.views[0]?.handlers.sendNow();

    expect(result?.text).toBe(SEND_TEXT.nothing);
    expect(result?.refresh).toBe(false);
  });

  it("**状況を読めなくてもダイアログは開き、そう書く**", async () => {
    const t = setup();
    t.sending.status = () => Promise.reject(new Error("digest"));
    start(t.cosense, t.deps);

    await t.clickMenu(MENU_TITLE);

    expect(t.views.map((entry) => entry.view)).toEqual([
      {
        kind: "message",
        lines: ["草の一覧を作れませんでした。ページを開き直して、もう一度押してください。"],
      },
    ]);
  });
});

describe("センサー", () => {
  it("読み込んだとき (start) に 1 回だけ始める", () => {
    const t = setup();

    start(t.cosense, t.deps);

    expect(t.sensor.started).toBe(1);
  });
});

describe("送信のきっかけ", () => {
  it("**読み込んだとき (start) に 1 回、load で送る**", () => {
    const t = setup();
    start(t.cosense, t.deps);
    expect(t.triggers).toEqual(["load"]);
  });

  it("**タブを隠すたびに hidden で送る。見えるようになっただけでは送らない**", async () => {
    const t = setup();
    start(t.cosense, t.deps);

    await t.setVisibility("hidden");
    await t.setVisibility("visible");
    await t.setVisibility("hidden");

    expect(t.triggers).toEqual(["load", "hidden", "hidden"]);
  });

  it("**「草の設定」の失効はその端末の登録を取り消し、結果の文言を返す**", async () => {
    const t = setup();
    start(t.cosense, t.deps);
    await t.openSettings();

    const message = await t.settingsViews[0]?.handlers.revoke();

    expect(t.revokes.count).toBe(1);
    expect(message).toBe(REVOKE_TEXT.revoked);

    t.revokes.outcome = "timeout";
    expect(await t.settingsViews[0]?.handlers.revoke()).toBe(REVOKE_TEXT.timeout);
  });

  it("**「草の設定」の削除はこのブラウザの記録だけを消し、結果の文言を返す**", async () => {
    const t = setup();
    start(t.cosense, t.deps);
    await t.openSettings();

    expect(await t.settingsViews[0]?.handlers.clear()).toBe(CLEAR_TEXT.cleared);
    expect(t.clears.count).toBe(1);

    t.clears.outcome = "failed";
    expect(await t.settingsViews[0]?.handlers.clear()).toBe(CLEAR_TEXT.failed);
  });

  it("**登録できたら enrolled で送る**。取り消したときは送らない", async () => {
    const t = setup();
    start(t.cosense, t.deps);
    await t.openSettings();

    t.settingsViews[0]?.handlers.signIn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.triggers).toEqual(["load", "enrolled"]);

    t.signIns.outcome = "cancelled";
    t.settingsViews[0]?.handlers.signIn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.triggers).toEqual(["load", "enrolled"]);
  });
});
