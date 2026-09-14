/**
 * UserScript のエントリ。Cosense のユーザーページから 1 行で import される
 * バンドルの入口 (ADR-0005)。
 *
 * 今は**センサー** (段階 5、Issue #49) が活動を数えて localStorage に記録する。送信は段階 6。
 * **サインインしてこの端末の鍵を登録する**メニュー (段階 4、Issue #61) を載せている。
 * ほかに、手で再確認するための**送信の疎通確認** (Issue #31) のメニューを載せている。
 * **記録の疎通確認** (Issue #36) のメニューは、試験用の公開鍵を消したときに一緒に消した (Issue #54)。
 * DOM 注入と設定 UI は段階 8。
 */
import { PH_ALL } from "../shared/ids.ts";
import { generateSigningKeyPair } from "../shared/sign.ts";
import { AUTH_POPUP_FEATURES, AUTH_POPUP_NAME, createSignIn, SIGN_IN_MENU_TITLE } from "./auth.ts";
import { requestImage } from "./image.ts";
import { createIndexedDbDeviceStore } from "./keys.ts";
import { describeResult, type ProbeResult, runProbe } from "./probe.ts";
import { describeSensorReport } from "./report.ts";
import { type Sensor, type SensorCosense, startExclusive, startSensor } from "./sensor.ts";
import { createDialogView } from "./sign-in-dialog.ts";
import { createStore, type Store } from "./store.ts";

/**
 * 配布バンドルの版。
 *
 * **破壊的変更のときは配布ページを分ける** (README のバージョン運用)。
 * 同一パスの中身を差し替えてよいのはバグ修正だけ。
 */
export const USERSCRIPT_VERSION = "0.0.0";

/** 合算の草を指す識別子。段階 8 の表示で使う。 */
export const AGGREGATE_PH = PH_ALL;

/** UserScript から使う `window.scrapbox` のうち、ここで触る部分だけ (research §2)。 */
export type Cosense = SensorCosense & {
  readonly PageMenu: {
    addItem(item: { title: string; onClick: () => void }): void;
  };
};

export const SENSOR_MENU_TITLE = "草: センサーの記録";

export const PROBE_MENU_TITLE = "草: 送信の疎通確認";

/** 1 日分のビットマップ (180 バイト)、分割のしきい値 (design §9)、Cloudflare の上限の近く。 */
export const PROBE_SIZES = [240, 8_000, 15_000] as const;

/** タブを隠したときに送った結果。**プロジェクト名はこのブラウザにだけ持つ** (design §9)。 */
export const HIDDEN_PROBE_KEY = "cosense-grass:probe:hidden";

const HIDDEN_PROBE_SIZE = 240;

type HiddenRecord = {
  readonly project: string;
  readonly at: string;
  /** 送ったときにページが Service Worker の制御下だったか */
  readonly controlled: boolean;
  readonly result: ProbeResult;
};

export type Dependencies = {
  /**
   * サインインしてこの端末を登録する。**メニューの onClick から同期で呼ぶ** (ポップアップを開くのに
   * クリックの直後である必要がある)
   */
  readonly signIn: () => unknown;
  /** センサーを始める。同じタブで動いている前のセンサーは止める */
  readonly startSensor: () => Sensor;
  readonly store: Pick<Store, "readDay">;
  readonly runProbe: (length: number) => Promise<ProbeResult>;
  readonly log: (message: string) => void;
  readonly alert: (message: string) => void;
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly document: Pick<Document, "addEventListener" | "visibilityState">;
  readonly now: () => Date;
  /**
   * ページが Service Worker の制御下か。**制御下だと Cosense の Service Worker が画像を作り直すので、
   * Referer が届く** (research §1)。強制再読み込みで開いたページは制御下にならない
   */
  readonly serviceWorkerControlled: () => boolean;
};

export function start(cosense: Cosense, deps: Dependencies): void {
  const sensor = deps.startSensor();

  cosense.PageMenu.addItem({
    title: SENSOR_MENU_TITLE,
    onClick: () => runSensorMenu(cosense, deps, sensor),
  });
  cosense.PageMenu.addItem({
    title: PROBE_MENU_TITLE,
    onClick: () => void runMenu(cosense, deps),
  });
  cosense.PageMenu.addItem({
    title: SIGN_IN_MENU_TITLE,
    onClick: () => {
      deps.signIn();
    },
  });

  // **読み込みごとに 1 回だけ。** 隠すたびに送ると、確認のたびに何本も飛ぶ
  let hiddenSent = false;
  deps.document.addEventListener("visibilitychange", () => {
    if (deps.document.visibilityState !== "hidden" || hiddenSent) {
      return;
    }
    hiddenSent = true;
    const project = cosense.Project.name;
    const at = deps.now().toISOString();
    const controlled = deps.serviceWorkerControlled();
    void deps.runProbe(HIDDEN_PROBE_SIZE).then((result) => {
      const record: HiddenRecord = { project, at, controlled, result };
      deps.storage.setItem(HIDDEN_PROBE_KEY, JSON.stringify(record));
    });
  });
}

function runSensorMenu(cosense: Cosense, deps: Dependencies, sensor: Sensor): void {
  const report = describeSensorReport({
    title: SENSOR_MENU_TITLE,
    now: deps.now(),
    project: cosense.Project.name,
    status: sensor.status(),
    store: deps.store,
  });
  deps.log(report.console);
  deps.alert(report.alert);
}

async function runMenu(cosense: Cosense, deps: Dependencies): Promise<void> {
  const controlled = deps.serviceWorkerControlled();
  const rows: { size: string; result: string }[] = [];
  // 大きい URL を同時に飛ばさないよう、順に送る
  for (const size of PROBE_SIZES) {
    rows.push({ size: `${size} 文字`, result: describeResult(await deps.runProbe(size)) });
  }

  const hidden = readHidden(deps.storage);
  rows.push({
    size: "タブを隠したとき",
    result: hidden
      ? `${describeResult(hidden.result)} (${hidden.project}, ${formatTime(hidden.at)}, ${describeController(hidden.controlled)})`
      : "まだ無い (タブを一度隠して戻ってから押す)",
  });

  console.table(rows);
  deps.alert(
    [
      `${PROBE_MENU_TITLE} (${cosense.Project.name}, ${formatTime(deps.now().toISOString())})`,
      describeController(controlled),
      "",
      ...rows.map((row) => `${row.size}: ${row.result}`),
    ].join("\n"),
  );
}

function readHidden(storage: Pick<Storage, "getItem">): HiddenRecord | undefined {
  const raw = storage.getItem(HIDDEN_PROBE_KEY);
  if (raw === null) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as HiddenRecord;
  } catch {
    return undefined;
  }
}

function describeController(controlled: boolean | undefined): string {
  // 古い版が残した記録には無い
  if (controlled === undefined) {
    return "Service Worker: 不明";
  }
  return controlled ? "Service Worker: 制御下" : "Service Worker: 制御外";
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP");
}

declare global {
  interface Window {
    scrapbox?: Cosense;
  }
}

// Cosense の上でだけ動く。テストで import しても何もしない
if (typeof window !== "undefined" && window.scrapbox) {
  const cosense = window.scrapbox;
  const warn = (message: string) => console.warn(`[cosense-grass] ${message}`);
  const store = createStore(window.localStorage, warn);
  start(cosense, {
    signIn: createSignIn({
      openPopup: (url) => window.open(url, AUTH_POPUP_NAME, AUTH_POPUP_FEATURES),
      messages: window,
      view: createDialogView(window.document),
      keys: createIndexedDbDeviceStore(window.indexedDB),
      generateKeyPair: generateSigningKeyPair,
      sendImage: (url) => requestImage(url),
      now: () => new Date(),
      log: (message) => console.info(message),
    }),
    startSensor: () =>
      // Symbol のキーで window に置く。別の版のバンドルからも同じキーで見つかる
      startExclusive(window as unknown as Record<symbol, unknown>, () =>
        startSensor(cosense, {
          store,
          now: () => new Date(),
          document: window.document,
          events: window,
          setInterval: (handler, ms) => window.setInterval(handler, ms),
          clearInterval: (id) => window.clearInterval(id),
          // 同一オリジン。connect-src 'self' なので通る (research §1)
          fetchText: async (path) => {
            const response = await fetch(path, { credentials: "same-origin" });
            return response.ok ? await response.text() : undefined;
          },
          warn,
        }),
      ),
    store,
    runProbe: (length) => runProbe(length),
    log: (message) => console.info(message),
    alert: (message) => window.alert(message),
    storage: window.localStorage,
    document: window.document,
    now: () => new Date(),
    serviceWorkerControlled: () => Boolean(window.navigator.serviceWorker?.controller),
  });
}
