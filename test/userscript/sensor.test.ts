import { describe, expect, it } from "vitest";
import {
  DISTRIBUTION_PATH,
  IDLE_MS,
  INTERACTION_EVENTS,
  SENSOR_REGISTRY_KEY,
  type Sensor,
  type SensorCosense,
  type SensorDependencies,
  startExclusive,
  startSensor,
  TICK_MS,
} from "../../src/userscript/sensor.ts";
import type { Activity } from "../../src/userscript/store.ts";

const PAGE_ID = "0123456789abcdef01234567";

// 時刻はローカル時刻の成分で作る (日と分はローカル時刻で決まる)
const at = (hours: number, minutes: number, seconds = 0, date = 14) =>
  new Date(2026, 8, date, hours, minutes, seconds).getTime();

const INSTALLED_SCRIPT = `import "${DISTRIBUTION_PATH}v1/script.js"\n`;

type Listener = (payload: { by?: string }) => void;

/** 偽の Cosense・document・window・タイマー・fetch。記録した活動と取得したパスを残す。 */
function setup(options: { project?: string; user?: string } = {}) {
  const recorded: Activity[] = [];
  const folded: string[] = [];
  const fetched: string[] = [];
  const warnings: string[] = [];
  const clock = { ms: at(9, 0, 5) };
  const doc = { visibilityState: "visible" as DocumentVisibilityState, focus: true };
  const eventListeners = new Map<string, () => void>();
  const lineListeners = new Set<Listener>();
  const timers = new Map<number, () => void>();
  const pendingFetches: { resolve: (text: string | undefined) => void; reject: () => void }[] = [];
  const state = { recordThrows: false };

  const cosense: SensorCosense & {
    Project: { name: string };
    Page: { id: string | null };
    Layout: string;
  } = {
    Project: { name: options.project ?? "project-a" },
    Page: { id: PAGE_ID },
    Layout: "page",
    User: { name: options.user ?? "alice" },
    on: (_event, listener) => lineListeners.add(listener),
    off: (_event, listener) => lineListeners.delete(listener),
  };

  const deps: SensorDependencies = {
    store: {
      record: (activity) => {
        if (state.recordThrows) {
          throw new Error("壊れた");
        }
        recorded.push(activity);
        return "written";
      },
      fold: (today) => {
        folded.push(today);
        return "unchanged";
      },
    },
    now: () => new Date(clock.ms),
    document: {
      get visibilityState() {
        return doc.visibilityState;
      },
      hasFocus: () => doc.focus,
    },
    events: {
      addEventListener: (type: string, listener: () => void) => eventListeners.set(type, listener),
      removeEventListener: (type: string) => eventListeners.delete(type),
    } as SensorDependencies["events"],
    setInterval: (handler, ms) => {
      expect(ms).toBe(TICK_MS);
      const id = timers.size + 1;
      timers.set(id, handler);
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    fetchText: (path) => {
      fetched.push(path);
      return new Promise((resolve, reject) => pendingFetches.push({ resolve, reject }));
    },
    warn: (message) => warnings.push(message),
  };

  return {
    cosense,
    deps,
    recorded,
    folded,
    fetched,
    warnings,
    clock,
    doc,
    eventListeners,
    lineListeners,
    timers,
    pendingFetches,
    state,
    /** 20 秒のポーリングを 1 回進める */
    tick(ms = clock.ms) {
      clock.ms = ms;
      for (const handler of timers.values()) {
        handler();
      }
    },
    interact(type: string = "mousemove") {
      eventListeners.get(type)?.();
    },
    emitLines(by?: string) {
      for (const listener of lineListeners) {
        listener({ by });
      }
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("読み", () => {
  it("**見えていて・フォーカスがあり・3 分以内に操作があれば、今の分に r を立てる**", () => {
    const t = setup();
    startSensor(t.cosense, t.deps);

    t.interact();
    t.tick(at(9, 0, 25));

    expect(t.recorded).toEqual([
      { kind: "read", project: "project-a", day: "2026-09-14", minute: 540 },
    ]);
  });

  it.each([
    ["タブが隠れている", (t: ReturnType<typeof setup>) => (t.doc.visibilityState = "hidden")],
    ["**フォーカスが無い** (開きっぱなしのタブを数えない)", (t) => (t.doc.focus = false)],
    ["設定画面など page / list / stream 以外", (t) => (t.cosense.Layout = "settings-profile-page")],
  ])("%s ときは立てない", (_label, change) => {
    const t = setup();
    startSensor(t.cosense, t.deps);
    t.interact();
    change(t);

    t.tick(at(9, 0, 25));

    expect(t.recorded).toEqual([]);
  });

  it("一覧 (list) と stream でも数える", () => {
    const t = setup();
    startSensor(t.cosense, t.deps);
    t.interact();

    t.cosense.Layout = "list";
    t.tick(at(9, 0, 25));
    t.cosense.Layout = "stream";
    t.tick(at(9, 1, 5));

    expect(t.recorded.map((a) => a.kind)).toEqual(["read", "read"]);
  });

  it(`**最後の操作から ${IDLE_MS / 60_000} 分を超えたら数えない。** 読み込んでから操作が無ければ数えない`, () => {
    const t = setup();
    startSensor(t.cosense, t.deps);

    t.tick(at(9, 0, 25));
    expect(t.recorded).toHaveLength(0);

    t.interact("scroll");
    t.tick(t.clock.ms + IDLE_MS);
    expect(t.recorded).toHaveLength(1);

    t.tick(t.clock.ms + 1);
    expect(t.recorded).toHaveLength(1);
  });

  it("操作とみなすイベントを capture で聞く", () => {
    const t = setup();
    startSensor(t.cosense, t.deps);

    expect([...t.eventListeners.keys()]).toEqual([...INTERACTION_EVENTS]);
  });

  it("**0 時をまたぐと新しい日に立てる。** 日が変わったら古い日を畳む", () => {
    const t = setup();
    t.clock.ms = at(23, 59, 40, 13);
    startSensor(t.cosense, t.deps);
    t.interact();

    t.tick(at(23, 59, 55, 13));
    t.tick(at(0, 0, 15, 14));
    t.tick(at(0, 0, 35, 14));

    expect(t.recorded.map((a) => [a.day, "minute" in a ? a.minute : undefined])).toEqual([
      ["2026-09-13", 1439],
      ["2026-09-14", 0],
      ["2026-09-14", 0],
    ]);
    // 起動時と、日が変わったときの 2 回
    expect(t.folded).toEqual(["2026-09-13", "2026-09-14"]);
  });
});

describe("書き", () => {
  it("**`by` が `edit` のときだけ、今の分に w を立ててページ ID を付ける**", () => {
    const t = setup();
    startSensor(t.cosense, t.deps);

    t.emitLines("edit");

    expect(t.recorded).toEqual([
      { kind: "write", project: "project-a", day: "2026-09-14", minute: 540, pageId: PAGE_ID },
    ]);
  });

  it.each([["remote"], ["navigation"], ["userscript"], [undefined]])(
    "`by` が %s なら立てない (他人の編集・ページ遷移・UserScript・undo)",
    (by) => {
      const t = setup();
      startSensor(t.cosense, t.deps);

      t.emitLines(by);

      expect(t.recorded).toEqual([]);
    },
  );

  it("ページ ID が無い (page 以外のレイアウト) ときは、分だけ立てる", () => {
    const t = setup();
    t.cosense.Page.id = null;
    startSensor(t.cosense, t.deps);

    t.emitLines("edit");

    expect(t.recorded[0]).toMatchObject({ kind: "write", pageId: undefined });
  });

  it("**記録で例外が起きても外へ投げない** (Cosense の他のリスナーを止めない)", () => {
    const t = setup();
    startSensor(t.cosense, t.deps);
    t.state.recordThrows = true;

    expect(() => t.emitLines("edit")).not.toThrow();
    expect(t.warnings).toHaveLength(1);
  });
});

describe("数えるプロジェクト", () => {
  it("**評価したプロジェクトは確かめずに数える**", () => {
    const t = setup();
    const sensor = startSensor(t.cosense, t.deps);

    t.emitLines("edit");

    expect(t.fetched).toEqual([]);
    expect(sensor.status()).toBe("counting");
    expect(t.recorded).toHaveLength(1);
  });

  it("**別のプロジェクトに移ると、自分のページに 1 行があると分かるまで数えない**", async () => {
    const t = setup({ user: "alice" });
    const sensor = startSensor(t.cosense, t.deps);

    t.cosense.Project.name = "project-b";
    t.emitLines("edit");
    t.emitLines("edit");

    expect(t.fetched).toEqual(["/api/code/project-b/alice/script.js"]);
    expect(sensor.status()).toBe("checking");
    expect(t.recorded).toEqual([]);

    t.pendingFetches[0]?.resolve(`console.log(1)\n${INSTALLED_SCRIPT}`);
    await flush();
    t.emitLines("edit");

    expect(sensor.status()).toBe("counting");
    expect(t.recorded).toMatchObject([{ kind: "write", project: "project-b" }]);
  });

  it("**1 行が無いプロジェクトでは数えない。元のプロジェクトに戻ればまた数える**", async () => {
    const t = setup();
    const sensor = startSensor(t.cosense, t.deps);

    t.cosense.Project.name = "project-b";
    t.emitLines("edit");
    t.pendingFetches[0]?.resolve("console.log('他の UserScript')");
    await flush();
    t.emitLines("edit");
    expect(sensor.status()).toBe("not-installed");

    t.cosense.Project.name = "project-a";
    t.emitLines("edit");

    expect(t.recorded).toMatchObject([{ kind: "write", project: "project-a" }]);
    // 一度確かめたプロジェクトは読み直さない
    t.cosense.Project.name = "project-b";
    t.emitLines("edit");
    expect(t.fetched).toHaveLength(1);
  });

  it("自分のページが無い (応答が成功でない) なら数えない", async () => {
    const t = setup();
    const sensor = startSensor(t.cosense, t.deps);

    t.cosense.Project.name = "project-b";
    t.emitLines("edit");
    t.pendingFetches[0]?.resolve(undefined);
    await flush();

    expect(sensor.status()).toBe("not-installed");
  });

  it("通信に失敗したら、次に数えようとしたときに確かめ直す", async () => {
    const t = setup();
    startSensor(t.cosense, t.deps);

    t.cosense.Project.name = "project-b";
    t.emitLines("edit");
    t.pendingFetches[0]?.reject();
    await flush();
    t.emitLines("edit");

    expect(t.fetched).toHaveLength(2);
  });

  it("ユーザー名が分からなければ、確かめずに数えない", () => {
    const t = setup();
    const sensor = startSensor(t.cosense, t.deps);

    t.cosense.Project.name = "project-b";
    (t.cosense as { User?: { name?: string } }).User = {};
    t.emitLines("edit");

    expect(t.fetched).toEqual([]);
    expect(sensor.status()).toBe("not-installed");
  });

  it("プロジェクト名とユーザー名はパスとしてエンコードする", () => {
    const t = setup({ user: "a/b" });
    startSensor(t.cosense, t.deps);

    t.cosense.Project.name = "x?y";
    t.emitLines("edit");

    expect(t.fetched).toEqual(["/api/code/x%3Fy/a%2Fb/script.js"]);
  });
});

describe("止める", () => {
  it("タイマー・操作のリスナー・`lines:changed` を外す", () => {
    const t = setup();
    const sensor = startSensor(t.cosense, t.deps);

    sensor.stop();

    expect(t.timers.size).toBe(0);
    expect(t.eventListeners.size).toBe(0);
    expect(t.lineListeners.size).toBe(0);
  });

  it("**同じタブで 2 つ動かさない。** 新しいセンサーは前のセンサーを止めてから始まる", () => {
    const registry: Record<symbol, unknown> = {};
    const events: string[] = [];
    const fake = (name: string): Sensor => ({
      stop: () => events.push(`stop ${name}`),
      status: () => "counting",
    });

    startExclusive(registry, () => {
      events.push("start 1");
      return fake("1");
    });
    const second = startExclusive(registry, () => {
      events.push("start 2");
      return fake("2");
    });

    expect(events).toEqual(["start 1", "stop 1", "start 2"]);
    expect(registry[SENSOR_REGISTRY_KEY]).toBe(second);
  });
});
