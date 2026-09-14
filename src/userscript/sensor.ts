/**
 * センサー (design §9、段階 5)。Cosense での活動を分単位で数え、`store.ts` に記録する。
 * 送るのは `sender.ts` (段階 6)。センサーは日付が変わったことを `onDayChange` で知らせるだけ。
 *
 * - **読み。** 20 秒ごとに、見えていて・フォーカスがあり・直近 3 分以内に操作があれば、今の分に r を立てる。
 *   `document.hasFocus()` が無いと、開きっぱなしのタブを全部数えてブラウザの起動時間になる
 * - **書き。** `lines:changed` の `by === "edit"` だけで今の分に w を立てる (ADR-0006)。他人の編集は `remote`
 *
 * **数えるのは、自分のページに import の 1 行があるプロジェクトだけ** (ADR-0007 決定 5)。配布モジュールは
 * 1 ドキュメントで 1 回しか評価されず、アプリ内でどのプロジェクトへ移っても動き続ける (research §2 の常駐)。
 * なので、評価したプロジェクト以外では、そのプロジェクトの自分の `script.js` を読んで 1 行があるかを確かめる。
 */
import type { Activity, Store } from "./store.ts";
import { localDay, localMinute } from "./time.ts";

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
  readonly Page: { readonly id: string | null };
  readonly Layout: string;
  /** 未ログインでは name が無い */
  readonly User?: { readonly name?: string };
  on(event: "lines:changed", listener: (payload: LinesChanged) => void): void;
  off(event: "lines:changed", listener: (payload: LinesChanged) => void): void;
};

export type SensorDependencies = {
  readonly store: Pick<Store, "record" | "fold">;
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

export function startSensor(cosense: SensorCosense, deps: SensorDependencies): Sensor {
  // **評価したプロジェクトは導入済み。** その script.js から読み込まれた
  const installed = new Map<string, "yes" | "no" | "checking">([[cosense.Project.name, "yes"]]);
  // 読み込む前の操作は見えない。最初の操作から数える
  let lastInteraction = Number.NEGATIVE_INFINITY;
  let lastDay: string | undefined;
  // 直前に記録できた活動。`lines:changed` はキー入力のたびに出るので、同じ分・同じページなら localStorage を読み直さない
  let lastRecorded: string | undefined;

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

  /** 今のプロジェクトを数えているときだけ記録する。 */
  function record(build: (project: string) => Activity): void {
    const project = cosense.Project.name;
    if (statusOf(project) !== "counting") {
      return;
    }
    const activity = build(project);
    const key = JSON.stringify(activity);
    if (key === lastRecorded) {
      return;
    }
    const outcome = deps.store.record(activity);
    // 書けなかったとき (容量超過・知らない版) は、次の活動で試し直す
    lastRecorded = outcome === "written" || outcome === "unchanged" ? key : undefined;
  }

  const tick = () =>
    guard(() => {
      const now = deps.now();
      const day = localDay(now);
      if (day !== lastDay) {
        const changed = lastDay !== undefined;
        lastDay = day;
        deps.store.fold(day);
        if (changed) {
          deps.onDayChange?.(day);
        }
      }
      if (
        deps.document.visibilityState !== "visible" ||
        !deps.document.hasFocus() ||
        now.getTime() - lastInteraction > IDLE_MS ||
        !COUNTED_LAYOUTS.has(cosense.Layout)
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
      record((project) => ({
        kind: "write",
        project,
        day: localDay(now),
        minute: localMinute(now),
        pageId: cosense.Page.id ?? undefined,
      }));
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
