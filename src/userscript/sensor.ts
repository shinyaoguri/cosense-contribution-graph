/**
 * センサー (design §9、段階 5)。Cosense での活動を分単位で数え、`store.ts` に記録する。
 * 送るのは `sender.ts` (段階 6)。センサーは日付が変わったことを `onDayChange` で知らせるだけ。
 *
 * - **読み。** 20 秒ごとに、見えていて・フォーカスがあり・直近 3 分以内に操作があれば、今の分に r を立てる。
 *   `document.hasFocus()` が無いと、開きっぱなしのタブを全部数えてブラウザの起動時間になる。
 *   **「設定」で off にされていれば数えない** (`countRead`。段階 8、Issue #79)
 * - **書き。** `lines:changed` の `by === "edit"` だけで今の分に w を立てる (ADR-0006)。他人の編集は `remote`
 * - **書いたページの振り分け** (ADR-0021、design §9)。ページごとに 1 回、同一オリジンの REST で作成者と作成日を引き、
 *   他の人のページなら関わる (`o`)、自分がその日に作ったページなら作る (`c`) に立てる。どちらでもなければ育てる (何も立てない)
 *
 * **数えるのは、自分のページに import の 1 行があるプロジェクトだけ** (ADR-0007 決定 5)。配布モジュールは
 * 1 ドキュメントで 1 回しか評価されず、アプリ内でどのプロジェクトへ移っても動き続ける (research §2 の常駐)。
 * なので、評価したプロジェクト以外では、そのプロジェクトの自分の `script.js` を読んで 1 行があるかを確かめる。
 */
import type { Activity, Store } from "./store.ts";
import { localDay, localMinute } from "./time.ts";

/** 自分の id を引くパス (`scrapbox.User` に id は無い。research §2)。 */
export const ME_PATH = "/api/users/me";

/** ページの作成者 (`user.id`) と作成時刻 (`created`、秒) を引くパス (research §4)。 */
export function pagePath(project: string, title: string): string {
  return `/api/pages/v2/${encodeURIComponent(project)}/${encodeURIComponent(title)}`;
}

/** 読みを判定する間隔。 */
export const TICK_MS = 20_000;

/** 最後の操作からこれを超えたら読みに数えない (離席判定。design §15 の仮値)。 */
export const IDLE_MS = 3 * 60_000;

/** 操作とみなすイベント (design §9)。 */
export const INTERACTION_EVENTS = [
  "scroll",
  "wheel",
  "mousemove",
  "pointerdown",
  "keydown",
  "touchmove",
] as const;

/** 読みに数えるレイアウト。Cosense が UserScript を読み直す条件と同じ (research §2)。設定画面などは数えない。 */
const COUNTED_LAYOUTS: ReadonlySet<string> = new Set(["page", "list", "stream"]);

/** 自分のページの `script.js` がこれを含めば、そのプロジェクトは導入済み。 */
export const DISTRIBUTION_PATH = "/api/code/cosense-grass/";

type LinesChanged = { readonly by?: string };

/** センサーが触る `window.scrapbox` の部分 (research §2)。 */
export type SensorCosense = {
  readonly Project: { readonly name: string };
  /** Layout が page 以外だと `null` */
  readonly Page: { readonly id: string | null; readonly title?: string | null };
  readonly Layout: string;
  /** 未ログインでは name が無い */
  readonly User?: { readonly name?: string };
  on(event: "lines:changed", listener: (payload: LinesChanged) => void): void;
  off(event: "lines:changed", listener: (payload: LinesChanged) => void): void;
};

export type SensorDependencies = {
  readonly store: Pick<Store, "record" | "sweep">;
  readonly now: () => Date;
  readonly document: Pick<Document, "visibilityState" | "hasFocus">;
  /** 操作のイベントを聞く先 (window) */
  readonly events: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  readonly setInterval: (handler: () => void, ms: number) => number;
  readonly clearInterval: (id: number) => void;
  /**
   * 同一オリジンのパスを読む。**応答が成功でなければ `undefined`** (404 = メンバーでない・ページが無い)。
   * 通信自体の失敗は例外にする (次のポーリングで確かめ直す)
   */
  readonly fetchText: (path: string) => Promise<string | undefined>;
  /**
   * 読みを数えるか (design §9「設定 UI」)。**数えるたびに読み直す**ので、別のタブで設定を変えても
   * 次の判定から効く。書きは止めない (草が空になる方が分かりにくい)
   */
  readonly countRead: () => boolean;
  readonly warn: (message: string) => void;
  /** 動いている間にローカルの日付が変わった (起動直後は呼ばない)。前日分を送るきっかけ */
  readonly onDayChange?: (today: string) => void;
};

/** 今のプロジェクトを数えているか。 */
export type CountingStatus = "counting" | "checking" | "not-installed";

export type Sensor = {
  stop(): void;
  status(): CountingStatus;
};

/** 振り分けに要る、ページの作成者と作成日。 */
type PageOrigin = { readonly mine: boolean; readonly createdDay: string };

/** 書いた 1 分。判定が返るまで控えておく。 */
type Minute = { readonly project: string; readonly day: string; readonly minute: number };

export function startSensor(cosense: SensorCosense, deps: SensorDependencies): Sensor {
  // **評価したプロジェクトは導入済み。** その script.js から読み込まれた
  const installed = new Map<string, "yes" | "no" | "checking">([[cosense.Project.name, "yes"]]);
  // 読み込む前の操作は見えない。最初の操作から数える
  let lastInteraction = Number.NEGATIVE_INFINITY;
  let lastDay: string | undefined;
  // 直前に記録できた活動 (種類ごと)。`lines:changed` はキー入力のたびに出るので、同じ分・同じページなら localStorage を読み直さない
  const lastRecorded = new Map<Activity["kind"], string>();
  // ページ ID → 作成者と作成日。**ドキュメントの寿命の間だけ覚える** (1 ページにつき 1 回しか引かない)
  const origins = new Map<string, PageOrigin | "checking">();
  // 判定が返るまで控えている分 (ページ ID → 分)
  const pending = new Map<string, Minute[]>();
  let myId: Promise<string> | undefined;

  const guard = (run: () => void) => {
    // Cosense のイベントの中で例外を投げると、同じイベントの他のリスナーまで止まる
    try {
      run();
    } catch (error) {
      deps.warn(`センサーで例外: ${String(error)}`);
    }
  };

  function statusOf(project: string): CountingStatus {
    const state = installed.get(project);
    if (state === undefined) {
      checkInstalled(project);
      return "checking";
    }
    return state === "yes" ? "counting" : state === "checking" ? "checking" : "not-installed";
  }

  function checkInstalled(project: string): void {
    const user = cosense.User?.name;
    if (!user) {
      installed.set(project, "no");
      return;
    }
    installed.set(project, "checking");
    const path = `/api/code/${encodeURIComponent(project)}/${encodeURIComponent(user)}/script.js`;
    deps.fetchText(path).then(
      (text) => installed.set(project, text?.includes(DISTRIBUTION_PATH) ? "yes" : "no"),
      // 通信の失敗は、次に数えようとしたときに確かめ直す
      () => installed.delete(project),
    );
  }

  /** 今のプロジェクトを数えているときだけ記録する。数えたかを返す。 */
  function record(build: (project: string) => Activity): boolean {
    const project = cosense.Project.name;
    if (statusOf(project) !== "counting") {
      return false;
    }
    commit(build(project));
    return true;
  }

  function commit(activity: Activity): void {
    const key = JSON.stringify(activity);
    if (key === lastRecorded.get(activity.kind)) {
      return;
    }
    const outcome = deps.store.record(activity);
    // 書けなかったとき (容量超過・知らない版) は、次の活動で試し直す
    if (outcome === "written" || outcome === "unchanged") {
      lastRecorded.set(activity.kind, key);
    } else {
      lastRecorded.delete(activity.kind);
    }
  }

  /** 書いた分を、ページの作成者と作成日で振り分ける (ADR-0021 決定 3)。 */
  function classify(pageId: string, title: string, written: Minute): void {
    const origin = origins.get(pageId);
    if (origin === undefined || origin === "checking") {
      const minutes = pending.get(pageId) ?? [];
      if (!minutes.some((m) => m.day === written.day && m.minute === written.minute)) {
        minutes.push(written);
      }
      pending.set(pageId, minutes);
      if (origin === undefined) {
        lookUp(pageId, written.project, title);
      }
      return;
    }
    assign(pageId, origin, written);
  }

  function assign(pageId: string, origin: PageOrigin, written: Minute): void {
    const { project, day, minute } = written;
    if (!origin.mine) {
      commit({ kind: "axis", project, day, minute, axis: "o" });
    } else if (origin.createdDay === day) {
      commit({ kind: "axis", project, day, minute, axis: "c" });
      commit({ kind: "created", project, day, pageId });
    }
    // 自分が前に作ったページは育てる。何も立てない (w − wc − wo で数える)
  }

  function lookUp(pageId: string, project: string, title: string): void {
    origins.set(pageId, "checking");
    Promise.all([me(), deps.fetchText(pagePath(project, title))])
      .then(([id, text]) => {
        const origin = text === undefined ? undefined : originOf(text, id);
        if (origin === undefined) {
          throw new Error("ページの作成者を読めなかった");
        }
        return origin;
      })
      .then(
        (origin) =>
          guard(() => {
            origins.set(pageId, origin);
            const minutes = pending.get(pageId) ?? [];
            pending.delete(pageId);
            for (const written of minutes) {
              assign(pageId, origin, written);
            }
          }),
        // **判定できなければ振り分けない** (その分は育てるに入る)。次の編集で引き直す
        () => {
          origins.delete(pageId);
          pending.delete(pageId);
        },
      );
  }

  /** 自分の id。ドキュメントの寿命に 1 回だけ引き、失敗したら次に引き直す。 */
  function me(): Promise<string> {
    if (myId === undefined) {
      const request = deps.fetchText(ME_PATH).then((text) => {
        const id = text === undefined ? undefined : idOf(text);
        if (id === undefined) {
          throw new Error("自分の id を読めなかった");
        }
        return id;
      });
      request.catch(() => {
        if (myId === request) {
          myId = undefined;
        }
      });
      myId = request;
    }
    return myId;
  }

  const tick = () =>
    guard(() => {
      const now = deps.now();
      const day = localDay(now);
      if (day !== lastDay) {
        const changed = lastDay !== undefined;
        lastDay = day;
        deps.store.sweep(day);
        if (changed) {
          deps.onDayChange?.(day);
        }
      }
      if (
        deps.document.visibilityState !== "visible" ||
        !deps.document.hasFocus() ||
        now.getTime() - lastInteraction > IDLE_MS ||
        !COUNTED_LAYOUTS.has(cosense.Layout) ||
        !deps.countRead()
      ) {
        return;
      }
      record((project) => ({ kind: "read", project, day, minute: localMinute(now) }));
    });

  const onInteraction = () => {
    lastInteraction = deps.now().getTime();
  };

  const onLinesChanged = ({ by }: LinesChanged) =>
    guard(() => {
      // undo / redo は by が undefined になり、ここでは数えない (research §2)
      if (by !== "edit") {
        return;
      }
      const now = deps.now();
      const day = localDay(now);
      const minute = localMinute(now);
      const pageId = cosense.Page.id ?? undefined;
      const counted = record((project) => ({ kind: "write", project, day, minute, pageId }));
      const title = cosense.Page.title;
      if (counted && pageId !== undefined && title) {
        classify(pageId, title, { project: cosense.Project.name, day, minute });
      }
    });

  for (const type of INTERACTION_EVENTS) {
    deps.events.addEventListener(type, onInteraction, { capture: true, passive: true });
  }
  cosense.on("lines:changed", onLinesChanged);
  const timer = deps.setInterval(tick, TICK_MS);
  // 起動時に古い日を畳む
  tick();

  return {
    stop() {
      deps.clearInterval(timer);
      for (const type of INTERACTION_EVENTS) {
        deps.events.removeEventListener(type, onInteraction, { capture: true });
      }
      cosense.off("lines:changed", onLinesChanged);
    },
    status: () => statusOf(cosense.Project.name),
  };
}

/** `/api/users/me` の応答から id を読む。未ログイン (`isGuest`) なら `undefined`。 */
function idOf(text: string): string | undefined {
  const json = parseJson(text);
  return isObject(json) && typeof json.id === "string" && json.id !== "" ? json.id : undefined;
}

/**
 * `/api/pages/v2/:project/:title` の応答から作成者と作成日を読む (research §4)。
 * **`persistent` は見ない。** まだ保存していないページも `user` は自分、`created` は今になる。
 */
function originOf(text: string, myId: string): PageOrigin | undefined {
  const json = parseJson(text);
  if (!isObject(json) || !isObject(json.user) || typeof json.user.id !== "string") {
    return undefined;
  }
  const created = json.created;
  if (typeof created !== "number" || !Number.isFinite(created)) {
    return undefined;
  }
  return { mine: json.user.id === myId, createdDay: localDay(new Date(created * 1000)) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 動いているセンサーを置く場所のキー。バンドルの版が違っても同じ値になる。 */
export const SENSOR_REGISTRY_KEY = Symbol.for("cosense-grass.sensor");

/**
 * **同じタブで 2 つ動かさない。** 前のセンサーを止めてから始める。
 * `dev` と `v1` を別々のプロジェクトで import していると、それぞれのモジュールが評価される。
 */
export function startExclusive(registry: Record<symbol, unknown>, start: () => Sensor): Sensor {
  const previous = registry[SENSOR_REGISTRY_KEY];
  if (isSensor(previous)) {
    previous.stop();
  }
  const sensor = start();
  registry[SENSOR_REGISTRY_KEY] = sensor;
  return sensor;
}

function isSensor(value: unknown): value is Sensor {
  return (
    typeof value === "object" &&
    value !== null &&
    "stop" in value &&
    typeof value.stop === "function"
  );
}
