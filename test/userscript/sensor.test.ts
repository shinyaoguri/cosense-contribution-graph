import { describe, expect, it } from "vitest";
import {
  DISTRIBUTION_PATH,
  IDLE_MS,
  INTERACTION_EVENTS,
  ME_PATH,
  pagePath,
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
  const swept: string[] = [];
  const fetched: string[] = [];
  const warnings: string[] = [];
  const clock = { ms: at(9, 0, 5) };
  const doc = { visibilityState: "visible" as DocumentVisibilityState, focus: true };
  const eventListeners = new Map<string, () => void>();
  const lineListeners = new Set<Listener>();
  const timers = new Map<number, () => void>();
  const pendingFetches: { resolve: (text: string | undefined) => void; reject: () => void }[] = [];
  const state = { recordThrows: false, countRead: true };
  const dayChanges: string[] = [];

  const cosense: SensorCosense & {
    Project: { name: string };
    Page: { id: string | null; title?: string | null };
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
      sweep: (today) => {
        swept.push(today);
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
    countRead: () => state.countRead,
    warn: (message) => warnings.push(message),
    onDayChange: (today) => dayChanges.push(today),
  };

  return {
    dayChanges,
    cosense,
    deps,
    recorded,
    swept,
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
    /** そのパスへの取得に応答する (`undefined` は成功でない応答、`"reject"` は通信の失敗) */
    respond(path: string, text: string | undefined | "reject") {
      const index = fetched.lastIndexOf(path);
      const fetch = pendingFetches[index];
      if (index < 0 || !fetch) {
        throw new Error(`${path} は取得されていない`);
      }
      if (text === "reject") {
        fetch.reject();
      } else {
        fetch.resolve(text);
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

  it("**0 時をまたぐと新しい日に立てる。** 日が変わったら古い記録を掃除する", () => {
    const t = setup();
    t.clock.ms = at(23, 59, 40, 13);
    startSensor(t.cosense, t.deps);
    t.interact();

    t.tick(at(23, 59, 55, 13));
    t.tick(at(0, 0, 15, 14));
    t.tick(at(0, 0, 35, 14));

    // 0:00:35 は 0:00:15 と同じ分なので記録しない
    expect(t.recorded.map((a) => [a.day, "minute" in a ? a.minute : undefined])).toEqual([
      ["2026-09-13", 1439],
      ["2026-09-14", 0],
    ]);
    // 起動時と、日が変わったときの 2 回
    expect(t.swept).toEqual(["2026-09-13", "2026-09-14"]);
    // **送信に知らせるのは日が変わったときだけ** (起動直後は読み込み時の送信が拾う)
    expect(t.dayChanges).toEqual(["2026-09-14"]);
  });
});

describe("read 計上の on/off (草の設定、Issue #79)", () => {
  it("**off なら読みを数えない**", () => {
    const t = setup();
    t.state.countRead = false;
    startSensor(t.cosense, t.deps);

    t.interact();
    t.tick(at(9, 0, 25));

    expect(t.recorded).toEqual([]);
  });

  it("**off でも書きは数える** (草が空になる方が分かりにくい)", () => {
    const t = setup();
    t.state.countRead = false;
    startSensor(t.cosense, t.deps);

    t.emitLines("edit");

    expect(t.recorded).toEqual([
      { kind: "write", project: "project-a", day: "2026-09-14", minute: 540, pageId: PAGE_ID },
    ]);
  });

  it("**数えるたびに読み直す** (別のタブで on に戻したら、次の判定から数える)", () => {
    const t = setup();
    t.state.countRead = false;
    startSensor(t.cosense, t.deps);

    t.interact();
    t.tick(at(9, 0, 25));
    t.state.countRead = true;
    t.tick(at(9, 0, 45));

    expect(t.recorded).toEqual([
      { kind: "read", project: "project-a", day: "2026-09-14", minute: 540 },
    ]);
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

  it("**同じ分・同じページの編集が続いても、store を呼ぶのは 1 回** (キー入力のたびに localStorage を読み直さない)", () => {
    const t = setup();
    startSensor(t.cosense, t.deps);

    t.emitLines("edit");
    t.emitLines("edit");
    t.cosense.Page.id = "fedcba9876543210fedcba98";
    t.emitLines("edit");
    t.clock.ms = at(9, 1, 0);
    t.emitLines("edit");

    expect(t.recorded.map((a) => (a.kind === "write" ? [a.minute, a.pageId] : []))).toEqual([
      [540, PAGE_ID],
      [540, "fedcba9876543210fedcba98"],
      [541, "fedcba9876543210fedcba98"],
    ]);
  });

  it("書けなかったときは、同じ活動でも次に試し直す", () => {
    const t = setup();
    const outcomes = ["failed", "written"] as const;
    const calls: Activity[] = [];
    t.deps = {
      ...t.deps,
      store: {
        ...t.deps.store,
        record: (activity) => {
          calls.push(activity);
          return outcomes[calls.length - 1] ?? "unchanged";
        },
      },
    };
    startSensor(t.cosense, t.deps);

    t.emitLines("edit");
    t.emitLines("edit");
    t.emitLines("edit");

    expect(calls).toHaveLength(2);
  });

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

describe("書いたページの振り分け (ADR-0021)", () => {
  const ME = "me-0001";
  const TITLE = "今日のメモ";
  const PAGE = pagePath("project-a", TITLE);
  /** REST の応答。`created` は秒 */
  const pageJson = (userId: string, createdMs: number) =>
    JSON.stringify({
      id: "rest-id",
      user: { id: userId },
      created: createdMs / 1000,
      persistent: true,
    });

  function started() {
    const t = setup();
    t.cosense.Page.title = TITLE;
    startSensor(t.cosense, t.deps);
    return t;
  }

  const axes = (recorded: readonly Activity[]) =>
    recorded.flatMap((a) => (a.kind === "axis" ? [[a.day, a.minute, a.axis]] : []));

  it("**自分が今日作ったページは作る。** w はすぐに立て、判定が返ってから c と created を立てる", async () => {
    const t = started();
    t.emitLines("edit");
    expect(t.fetched).toEqual([ME_PATH, PAGE]);
    expect(t.recorded.map((a) => a.kind)).toEqual(["write"]);

    t.respond(ME_PATH, JSON.stringify({ id: ME, name: "alice" }));
    t.respond(PAGE, pageJson(ME, at(8, 30)));
    await flush();

    expect(axes(t.recorded)).toEqual([["2026-09-14", 540, "c"]]);
    expect(t.recorded).toContainEqual({
      kind: "created",
      project: "project-a",
      day: "2026-09-14",
      pageId: PAGE_ID,
    });
  });

  it("**まだ保存していないページ** (作成者が自分、作成時刻が今) も作る", async () => {
    const t = started();
    t.emitLines("edit");
    t.respond(ME_PATH, JSON.stringify({ id: ME }));
    t.respond(
      PAGE,
      JSON.stringify({ user: { id: ME }, created: t.clock.ms / 1000, persistent: false }),
    );
    await flush();

    expect(axes(t.recorded)).toEqual([["2026-09-14", 540, "c"]]);
  });

  it("**他の人が作ったページは関わる**", async () => {
    const t = started();
    t.emitLines("edit");
    t.respond(ME_PATH, JSON.stringify({ id: ME }));
    t.respond(PAGE, pageJson("someone-else", at(8, 30)));
    await flush();

    expect(axes(t.recorded)).toEqual([["2026-09-14", 540, "o"]]);
    expect(t.recorded.some((a) => a.kind === "created")).toBe(false);
  });

  it("**自分が前の日に作ったページは育てる** (何も立てない)", async () => {
    const t = started();
    t.emitLines("edit");
    t.respond(ME_PATH, JSON.stringify({ id: ME }));
    t.respond(PAGE, pageJson(ME, at(23, 50, 0, 13)));
    await flush();

    expect(t.recorded.map((a) => a.kind)).toEqual(["write"]);
  });

  it("**1 ページにつき 1 回しか引かず、判定の後の編集はすぐ振り分ける**", async () => {
    const t = started();
    t.emitLines("edit");
    t.clock.ms = at(9, 1);
    t.emitLines("edit");
    expect(t.fetched).toEqual([ME_PATH, PAGE]);

    t.respond(ME_PATH, JSON.stringify({ id: ME }));
    t.respond(PAGE, pageJson("someone-else", at(8, 30)));
    await flush();
    expect(axes(t.recorded)).toEqual([
      ["2026-09-14", 540, "o"],
      ["2026-09-14", 541, "o"],
    ]);

    t.clock.ms = at(9, 2);
    t.emitLines("edit");
    expect(t.fetched).toHaveLength(2);
    expect(axes(t.recorded).at(-1)).toEqual(["2026-09-14", 542, "o"]);
  });

  it("**自分の id は 1 回だけ引く** (別のページでは作成者だけを引く)", async () => {
    const t = started();
    t.emitLines("edit");
    t.respond(ME_PATH, JSON.stringify({ id: ME }));
    t.respond(PAGE, pageJson(ME, at(8, 30)));
    await flush();

    t.cosense.Page.id = "fedcba9876543210fedcba98";
    t.cosense.Page.title = "別のページ";
    t.emitLines("edit");

    expect(t.fetched).toEqual([ME_PATH, PAGE, pagePath("project-a", "別のページ")]);
  });

  it("**判定の途中で日付が変わっても、控えた分は書いた日に振り分ける**", async () => {
    const t = started();
    t.clock.ms = at(23, 59, 30);
    t.emitLines("edit");
    t.clock.ms = at(0, 0, 10, 15);
    t.emitLines("edit");

    t.respond(ME_PATH, JSON.stringify({ id: ME }));
    // 14 日の 23:58 に作ったページ: 14 日の分は作る、15 日の分は育てる
    t.respond(PAGE, pageJson(ME, at(23, 58)));
    await flush();

    expect(axes(t.recorded)).toEqual([["2026-09-14", 1439, "c"]]);
  });

  it.each([
    ["通信の失敗", "reject"],
    ["成功でない応答", undefined],
    ["JSON でない応答", "<html>"],
    ["作成者の無い応答", JSON.stringify({ created: 1 })],
  ] as const)("**%sなら振り分けず、次の編集で引き直す**", async (_name, response) => {
    const t = started();
    t.emitLines("edit");
    t.respond(ME_PATH, JSON.stringify({ id: ME }));
    t.respond(PAGE, response);
    await flush();
    expect(t.recorded.map((a) => a.kind)).toEqual(["write"]);

    t.clock.ms = at(9, 1);
    t.emitLines("edit");
    expect(t.fetched.filter((path) => path === PAGE)).toHaveLength(2);
  });

  it("**自分の id が読めなければ振り分けず、次は id から引き直す** (未ログインなど)", async () => {
    const t = started();
    t.emitLines("edit");
    t.respond(ME_PATH, JSON.stringify({ isGuest: true }));
    t.respond(PAGE, pageJson(ME, at(8, 30)));
    await flush();
    expect(t.recorded.map((a) => a.kind)).toEqual(["write"]);

    t.clock.ms = at(9, 1);
    t.emitLines("edit");
    expect(t.fetched.filter((path) => path === ME_PATH)).toHaveLength(2);
  });

  it("タイトルが無い (page 以外のレイアウト) か、数えていないプロジェクトでは引かない", () => {
    const t = started();
    t.cosense.Page.title = null;
    t.emitLines("edit");
    expect(t.fetched).toEqual([]);
  });

  it("プロジェクト名とタイトルはパスとしてエンコードする", () => {
    expect(pagePath("my project", "a/b?c#d")).toBe("/api/pages/v2/my%20project/a%2Fb%3Fc%23d");
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
