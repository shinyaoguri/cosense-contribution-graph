import { describe, expect, it } from "vitest";
import {
  type Cosense,
  type Dependencies,
  HIDDEN_PROBE_KEY,
  PROBE_MENU_TITLE,
  PROBE_SIZES,
  SENSOR_MENU_TITLE,
  start,
} from "../../src/userscript/index.ts";
import type { ProbeResult } from "../../src/userscript/probe.ts";
import type { CountingStatus } from "../../src/userscript/sensor.ts";
import { createStore } from "../../src/userscript/store.ts";
import { localDay } from "../../src/userscript/time.ts";

const LOADED: ProbeResult = {
  kind: "loaded",
  flags: { intact: true, referer: false, notImageDest: false, refererPath: false },
};

/** 偽の Cosense と依存。送った大きさ・alert・localStorage・イベントを記録する。 */
function setup(projectName = "project-a", controlled = true) {
  const sizes: number[] = [];
  const alerts: string[] = [];
  const logs: string[] = [];
  const clock = { ms: Date.parse("2026-09-13T06:00:00Z") };
  const items: { title: string; onClick: () => void }[] = [];
  const store = new Map<string, string>();
  const listeners: (() => void)[] = [];
  const doc = { visibilityState: "visible" as DocumentVisibilityState };

  const project = { name: projectName };
  const state = { controlled };
  const sensor = { started: 0, status: "counting" as CountingStatus };
  const records = createStore(
    { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    () => undefined,
  );
  const cosense: Cosense = {
    Project: project,
    Page: { id: null },
    Layout: "page",
    on: () => undefined,
    off: () => undefined,
    PageMenu: { addItem: (item) => items.push(item) },
  };
  const deps: Dependencies = {
    startSensor: () => {
      sensor.started++;
      return { stop: () => undefined, status: () => sensor.status };
    },
    store: records,
    runProbe: async (length) => {
      sizes.push(length);
      return LOADED;
    },
    log: (message) => logs.push(message),
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
    now: () => new Date(clock.ms),
    serviceWorkerControlled: () => state.controlled,
  };

  /** 表示状態を変えてイベントを発火する。送信の完了まで待つ。 */
  async function setVisibility(state: DocumentVisibilityState) {
    doc.visibilityState = state;
    for (const listener of listeners) {
      listener();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function clickMenu(title = PROBE_MENU_TITLE) {
    const item = items.find((i) => i.title === title);
    if (!item) {
      throw new Error("メニューが無い");
    }
    item.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return {
    cosense,
    deps,
    sizes,
    alerts,
    logs,
    clock,
    items,
    store,
    records,
    sensor,
    project,
    state,
    setVisibility,
    clickMenu,
  };
}

describe("ページメニュー", () => {
  it("「草: センサーの記録」と、送信の疎通確認を足す", () => {
    const t = setup();

    start(t.cosense, t.deps);

    expect(t.items.map((i) => i.title)).toEqual([SENSOR_MENU_TITLE, PROBE_MENU_TITLE]);
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

  it("**押した時点でページが Service Worker の制御下かを出す** (Referer が届くかを左右する)", async () => {
    const controlled = setup("project-a", true);
    start(controlled.cosense, controlled.deps);
    await controlled.clickMenu();

    const uncontrolled = setup("project-a", false);
    start(uncontrolled.cosense, uncontrolled.deps);
    await uncontrolled.clickMenu();

    expect(controlled.alerts[0]).toContain("Service Worker: 制御下");
    expect(uncontrolled.alerts[0]).toContain("Service Worker: 制御外");
  });
});

describe("センサー", () => {
  it("読み込んだとき (start) に 1 回だけ始める", () => {
    const t = setup();

    start(t.cosense, t.deps);

    expect(t.sensor.started).toBe(1);
  });

  it("**メニューを押すと、今日の記録と数えているかを alert とコンソールに出す。送信はしない**", async () => {
    const t = setup("project-a");
    const today = localDay(new Date(t.clock.ms));
    t.records.record({ kind: "write", project: "project-a", day: today, minute: 540 });
    t.records.record({ kind: "read", project: "project-b", day: today, minute: 541 });
    start(t.cosense, t.deps);

    await t.clickMenu(SENSOR_MENU_TITLE);

    const text = t.alerts[0] ?? "";
    expect(text).toContain("草: センサーの記録 (");
    expect(text).toContain("このタブ: project-a を数えている");
    expect(text).toContain("合算: 書き 1 分 / 読み 1 分");
    expect(text).toContain("project-b: 書き 0 分 / 読み 1 分");
    expect(text).toContain("9:00–9:01 書き 1 分");
    expect(t.logs).toHaveLength(1);
    expect(t.sizes).toEqual([]);
  });

  it("数えていないプロジェクトではそう出す", async () => {
    const t = setup("project-c");
    t.sensor.status = "not-installed";
    start(t.cosense, t.deps);

    await t.clickMenu(SENSOR_MENU_TITLE);

    expect(t.alerts[0]).toContain("このタブ: project-c は数えていない");
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
      controlled: true,
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
    t.state.controlled = false;
    await t.clickMenu();

    const text = t.alerts[0] ?? "";
    expect(text).toContain("(project-b,");
    expect(text).toContain("Service Worker: 制御外");
    // 隠したときの制御状態は、送ったときの値を出す
    expect(text).toMatch(
      /タブを隠したとき: 届いた \/ 中身一致 .*\(project-a, .*, Service Worker: 制御下\)/,
    );
  });

  it("古い版が残した記録 (制御状態が無い) は「不明」と出す", async () => {
    const t = setup();
    t.store.set(
      HIDDEN_PROBE_KEY,
      JSON.stringify({ project: "project-a", at: "2026-09-13T06:00:00.000Z", result: LOADED }),
    );
    start(t.cosense, t.deps);

    await t.clickMenu();

    expect(t.alerts[0]).toMatch(/タブを隠したとき: .*Service Worker: 不明\)/);
  });
});
