import { describe, expect, it } from "vitest";
import {
  type Cosense,
  type Dependencies,
  HIDDEN_PROBE_KEY,
  PROBE_MENU_TITLE,
  PROBE_SIZES,
  start,
} from "../../src/userscript/index.ts";
import type { ProbeResult } from "../../src/userscript/probe.ts";

const LOADED: ProbeResult = {
  kind: "loaded",
  flags: { intact: true, referer: false, notImageDest: false, refererPath: false },
};

/** 偽の Cosense と依存。送った大きさ・alert・localStorage・イベントを記録する。 */
function setup(projectName = "project-a") {
  const sizes: number[] = [];
  const alerts: string[] = [];
  const items: { title: string; onClick: () => void }[] = [];
  const store = new Map<string, string>();
  const listeners: (() => void)[] = [];
  const doc = { visibilityState: "visible" as DocumentVisibilityState };

  const project = { name: projectName };
  const cosense: Cosense = {
    Project: project,
    PageMenu: { addItem: (item) => items.push(item) },
  };
  const deps: Dependencies = {
    runProbe: async (length) => {
      sizes.push(length);
      return LOADED;
    },
    alert: (message) => alerts.push(message),
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
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
    now: () => new Date("2026-09-13T06:00:00Z"),
  };

  /** 表示状態を変えてイベントを発火する。送信の完了まで待つ。 */
  async function setVisibility(state: DocumentVisibilityState) {
    doc.visibilityState = state;
    for (const listener of listeners) {
      listener();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function clickMenu() {
    const item = items.find((i) => i.title === PROBE_MENU_TITLE);
    if (!item) {
      throw new Error("メニューが無い");
    }
    item.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { cosense, deps, sizes, alerts, items, store, project, setVisibility, clickMenu };
}

describe("ページメニュー", () => {
  it("「草: 送信の疎通確認」を 1 つ足す", () => {
    const t = setup();

    start(t.cosense, t.deps);

    expect(t.items.map((i) => i.title)).toEqual([PROBE_MENU_TITLE]);
  });

  it("押すと 3 つの大きさを順に送り、プロジェクト名と結果を alert に出す", async () => {
    const t = setup();
    start(t.cosense, t.deps);

    await t.clickMenu();

    expect(t.sizes).toEqual([...PROBE_SIZES]);
    expect(PROBE_SIZES).toEqual([240, 8_000, 15_000]);
    expect(t.alerts).toHaveLength(1);
    const text = t.alerts[0] ?? "";
    expect(text).toContain("project-a");
    for (const size of PROBE_SIZES) {
      expect(text).toContain(`${size} 文字: 届いた / 中身一致`);
    }
    expect(text).toContain("タブを隠したとき: まだ無い");
  });
});

describe("タブを隠したときの送信", () => {
  it("隠したら 240 文字を 1 回送り、プロジェクト名と時刻つきで残す", async () => {
    const t = setup();
    start(t.cosense, t.deps);

    await t.setVisibility("hidden");

    expect(t.sizes).toEqual([240]);
    expect(JSON.parse(t.store.get(HIDDEN_PROBE_KEY) ?? "null")).toEqual({
      project: "project-a",
      at: "2026-09-13T06:00:00.000Z",
      result: LOADED,
    });
  });

  it("**読み込みごとに 1 回だけ。** 何度隠しても増えない", async () => {
    const t = setup();
    start(t.cosense, t.deps);

    await t.setVisibility("hidden");
    await t.setVisibility("visible");
    await t.setVisibility("hidden");

    expect(t.sizes).toEqual([240]);
  });

  it("見えるようになっただけでは送らない", async () => {
    const t = setup();
    start(t.cosense, t.deps);

    await t.setVisibility("visible");

    expect(t.sizes).toEqual([]);
  });

  it("残した結果は次にメニューを押したとき、送ったプロジェクトの名前つきで出る", async () => {
    const t = setup("project-a");
    start(t.cosense, t.deps);
    await t.setVisibility("hidden");

    t.project.name = "project-b";
    await t.clickMenu();

    const text = t.alerts[0] ?? "";
    expect(text).toContain("(project-b,");
    expect(text).toMatch(/タブを隠したとき: 届いた \/ 中身一致 .*\(project-a, /);
  });
});
