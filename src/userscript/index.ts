/**
 * UserScript のエントリ。Cosense のユーザーページから 1 行で import される
 * バンドルの入口 (ADR-0005)。
 *
 * **センサー** (段階 5、Issue #49) が活動を数えて localStorage に記録し、**登録した鍵で署名して送る** (段階 6、Issue #67)。
 * 送るのは読み込み時・日付の変更・タブを隠したとき・登録の成功のとき (`sender.ts`)。
 * **合算とプロジェクト別の草を見る**メニュー (段階 8、Issue #73) と、**草の設定**のメニュー (段階 8、Issue #79) を載せている。
 * サインイン (段階 4、Issue #61) は単独のメニューをやめ、「草の設定」に集約した (design §9)。
 * ほかに、手で再確認するための**送信の疎通確認** (Issue #31) のメニューを載せている。
 * タブを隠したときに疎通確認を自動で送るのは、本物の送信が入ったので消した (Issue #67)。
 * **記録の疎通確認** (Issue #36) のメニューは、試験用の公開鍵を消したときに一緒に消した (Issue #54)。
 * 「草の設定」のデバイスの失効と全データの削除は段階 8 の残り (Issue #79)。
 */
import { generateSigningKeyPair } from "../shared/sign.ts";
import { AUTH_POPUP_FEATURES, AUTH_POPUP_NAME, createSignIn } from "./auth.ts";
import { createGraphDialog, type GraphDialog } from "./graph-dialog.ts";
import { requestImage } from "./image.ts";
import { createIndexedDbDeviceStore } from "./keys.ts";
import { describeResult, type ProbeResult, runProbe } from "./probe.ts";
import { describeSensorReport } from "./report.ts";
import { createSender, type Sender } from "./sender.ts";
import { type Sensor, type SensorCosense, startExclusive, startSensor } from "./sensor.ts";
import { describeSettings, SETTINGS_MENU_TITLE } from "./settings.ts";
import { createSettingsDialog, type SettingsDialog } from "./settings-dialog.ts";
import { createSettings, type SettingsAccess } from "./settings-store.ts";
import { createDialogView } from "./sign-in-dialog.ts";
import { createStore, type Store } from "./store.ts";
import { localDay } from "./time.ts";
import {
  describeIntegrated,
  describeLocal,
  type IntegratedView,
  localRangeStart,
  VIEW_MENU_TITLE,
} from "./viewer.ts";

/**
 * 配布バンドルの版。
 *
 * **破壊的変更のときは配布ページを分ける** (README のバージョン運用)。
 * 同一パスの中身を差し替えてよいのはバグ修正だけ。
 */
export const USERSCRIPT_VERSION = "0.0.0";

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

export type Dependencies = {
  /**
   * サインインしてこの端末を登録する。**メニューの onClick から同期で呼ぶ** (ポップアップを開くのに
   * クリックの直後である必要がある)
   */
  readonly signIn: () => Promise<string>;
  readonly sender: Pick<Sender, "trigger" | "status">;
  readonly graphDialog: Pick<GraphDialog, "open">;
  readonly settingsDialog: Pick<SettingsDialog, "open">;
  /** 設定の読み書き。**開くたびに読み直す** (別のタブで変えた値を拾う) */
  readonly settings: Pick<SettingsAccess, "read">;
  /** センサーを始める。同じタブで動いている前のセンサーは止める */
  readonly startSensor: () => Sensor;
  readonly store: Pick<Store, "readDay" | "readRange">;
  readonly runProbe: (length: number) => Promise<ProbeResult>;
  readonly log: (message: string) => void;
  readonly alert: (message: string) => void;
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
    title: VIEW_MENU_TITLE,
    onClick: () => void runViewMenu(cosense, deps),
  });
  cosense.PageMenu.addItem({
    title: SETTINGS_MENU_TITLE,
    onClick: () => void runSettingsMenu(deps),
  });
  cosense.PageMenu.addItem({
    title: SENSOR_MENU_TITLE,
    onClick: () => void runSensorMenu(cosense, deps, sensor),
  });
  cosense.PageMenu.addItem({
    title: PROBE_MENU_TITLE,
    onClick: () => void runMenu(cosense, deps),
  });

  void deps.sender.trigger("load");
  // **隠すたびに送る。** 変化が無ければ送らず、当日分は 1 日 4 回まで (sender.ts)
  deps.document.addEventListener("visibilitychange", () => {
    if (deps.document.visibilityState === "hidden") {
      void deps.sender.trigger("hidden");
    }
  });
}

/** 押すたびに登録の状態と設定を読み直す (別のタブで登録・変更したものを拾う) */
async function runSettingsMenu(deps: Dependencies): Promise<void> {
  const status = await deps.sender.status();
  deps.settingsDialog.open(describeSettings(status, deps.settings.read()), {
    // ポップアップを開くのは signIn の同期区間。登録できたら、貯まっていた記録と今日の分を送る
    signIn: () => {
      void deps.signIn().then((outcome) => {
        if (outcome === "added" || outcome === "known") {
          void deps.sender.trigger("enrolled");
        }
      });
    },
  });
}

/** 押すたびに鍵・送信の記録・センサーの記録を読み直す (別のタブで登録・送信・記録したものを拾う) */
async function runViewMenu(cosense: Cosense, deps: Dependencies): Promise<void> {
  const project = cosense.Project.name;
  let integrated: IntegratedView;
  try {
    integrated = describeIntegrated(await deps.sender.status(), project);
  } catch {
    integrated = {
      kind: "message",
      lines: ["草の一覧を作れませんでした。ページを開き直して、もう一度押してください。"],
    };
  }
  // 状況を待った後の時刻で読む (日付をまたいでも、今日の列と記録が食い違わない)
  const today = localDay(deps.now());
  const local = describeLocal(deps.store.readRange(localRangeStart(today), today), today, project);
  deps.graphDialog.open({ integrated, local });
}

async function runSensorMenu(cosense: Cosense, deps: Dependencies, sensor: Sensor): Promise<void> {
  const sending = await deps.sender.status();
  const report = describeSensorReport({
    sending,
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

function describeController(controlled: boolean): string {
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
  const settings = createSettings(window.localStorage);
  const keys = createIndexedDbDeviceStore(window.indexedDB);
  const sender = createSender({
    store,
    keys,
    sendImage: (url) => requestImage(url),
    storage: window.localStorage,
    now: () => new Date(),
    // Web Locks で別のタブ・別の版のバンドルと直列にする。無ければそのまま (OR なので重なっても無害)
    withLock: (run) =>
      window.navigator.locks ? window.navigator.locks.request("cosense-grass:send", run) : run(),
    warn,
  });
  start(cosense, {
    sender,
    settings,
    settingsDialog: createSettingsDialog(window.document, {
      setCountRead: (value) => settings.setCountRead(value),
    }),
    graphDialog: createGraphDialog(window.document, {
      writeText: (text) =>
        window.navigator.clipboard
          ? window.navigator.clipboard.writeText(text)
          : Promise.reject(new Error("clipboard が無い")),
    }),
    signIn: createSignIn({
      openPopup: (url) => window.open(url, AUTH_POPUP_NAME, AUTH_POPUP_FEATURES),
      messages: window,
      view: createDialogView(window.document),
      keys,
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
          countRead: () => settings.read().settings.countRead,
          clearInterval: (id) => window.clearInterval(id),
          // 同一オリジン。connect-src 'self' なので通る (research §1)
          fetchText: async (path) => {
            const response = await fetch(path, { credentials: "same-origin" });
            return response.ok ? await response.text() : undefined;
          },
          warn,
          onDayChange: () => void sender.trigger("day-change"),
        }),
      ),
    store,
    runProbe: (length) => runProbe(length),
    log: (message) => console.info(message),
    alert: (message) => window.alert(message),
    document: window.document,
    now: () => new Date(),
    serviceWorkerControlled: () => Boolean(window.navigator.serviceWorker?.controller),
  });
}
