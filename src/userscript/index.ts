/**
 * UserScript のエントリ。Cosense のユーザーページから 1 行で import される
 * バンドルの入口 (ADR-0005)。
 *
 * 今は**センサー** (段階 5、Issue #49) が活動を数えて localStorage に記録する。送信は段階 6。
 * ほかに、手で再確認するための**送信の疎通確認** (Issue #31) と**記録の疎通確認** (Issue #36) のメニューを載せている。
 * DOM 注入と設定 UI は段階 8。
 */
import { PH_ALL } from "../shared/ids.ts";
import { describeResult, type ProbeResult, runProbe } from "./probe.ts";
import {
  describeRecord,
  indexedDbKeyStore,
  type RecordReport,
  runRecord,
  sendRecord,
} from "./record.ts";
import { describeSensorReport } from "./report.ts";
import { type Sensor, type SensorCosense, startExclusive, startSensor } from "./sensor.ts";
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

export const RECORD_MENU_TITLE = "草: 記録の疎通確認";

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
  /** センサーを始める。同じタブで動いている前のセンサーは止める */
  readonly startSensor: () => Sensor;
  readonly store: Pick<Store, "readDay">;
  readonly runProbe: (length: number) => Promise<ProbeResult>;
  /** 試しの活動を署名して送る。プロジェクト名は ph の計算にだけ使う */
  readonly runRecord: (projectName: string) => Promise<RecordReport>;
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

  // **記録の送信は 1 本の列に並べる。** メニューを続けて押しても、前の送信が終わってから次を始める。
  // 初めてのブラウザで IndexedDB の鍵を 2 本作り、片方で上書きするのを防ぐ
  const enqueueRecord = serialQueue();

  cosense.PageMenu.addItem({
    title: SENSOR_MENU_TITLE,
    onClick: () => runSensorMenu(cosense, deps, sensor),
  });
  cosense.PageMenu.addItem({
    title: PROBE_MENU_TITLE,
    onClick: () => void runMenu(cosense, deps),
  });
  cosense.PageMenu.addItem({
    title: RECORD_MENU_TITLE,
    onClick: () => void enqueueRecord(() => runRecordMenu(cosense, deps)),
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

type Enqueue = (task: () => Promise<void>) => Promise<void>;

/** 渡した仕事を 1 つずつ順に走らせる。前の仕事が失敗しても次は走る。 */
function serialQueue(): Enqueue {
  let tail: Promise<void> = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
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

async function runRecordMenu(cosense: Cosense, deps: Dependencies): Promise<void> {
  const project = cosense.Project.name;
  let report: RecordReport;
  try {
    report = await deps.runRecord(project);
  } catch (error) {
    // IndexedDB が使えない・鍵を読み戻せない (Firefox に報告がある) とここに来る
    deps.alert(
      [`${RECORD_MENU_TITLE} (${project})`, "", `★送る前に失敗した: ${String(error)}`].join("\n"),
    );
    return;
  }

  const lines = [
    `${RECORD_MENU_TITLE} (${project}, ${formatTime(deps.now().toISOString())})`,
    "",
    `結果: ${describeRecord(report.result)}`,
    `送った日: ${report.day} (書き 5 分・読み 10 分の固定パターン)`,
    `鍵: ${report.createdKey ? "新しく作って IndexedDB に保存した" : "IndexedDB から読み戻した"}`,
    `kid: ${report.kid}`,
    `公開鍵: ${report.publicKey}`,
    "",
    `合算の草: ${report.wholeGraphUrl}`,
    `このプロジェクトの草: ${report.projectGraphUrl}`,
    "",
    "同じ内容をコンソールにも出した (コピーはそちらから)",
  ];
  deps.log(lines.join("\n"));
  deps.alert(lines.join("\n"));
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
    runRecord: (projectName) =>
      runRecord(projectName, {
        keyStore: indexedDbKeyStore,
        storage: window.localStorage,
        now: () => new Date(),
        send: (url) => sendRecord(url),
      }),
    log: (message) => console.info(message),
    alert: (message) => window.alert(message),
    storage: window.localStorage,
    document: window.document,
    now: () => new Date(),
    serviceWorkerControlled: () => Boolean(window.navigator.serviceWorker?.controller),
  });
}
