/**
 * UserScript のエントリ。Cosense のユーザーページから 1 行で import される
 * バンドルの入口 (ADR-0005)。
 *
 * **センサー** (段階 5、Issue #49) が活動を数えて localStorage に記録し、**登録した鍵で署名して送る** (段階 6、Issue #67)。
 * 送るのは読み込み時・日付の変更・タブを隠したとき・登録の成功のとき、
 * それに**草のダイアログの「今すぐ送る」を押したとき** (`sender.ts`、Issue #102)。
 *
 * **草を描くのは Worker だけ** (ADR-0019、Issue #109)。ダイアログに出すのは共有 SVG の `<img>` で、
 * UserScript は数えて送るだけにした。
 *
 * **ページメニューに足すのは `cosense-grass` の 1 つだけ** (Issue #95)。ほかのスクリプトと並ぶ場所なので
 * 占有を最小にし、**どのスクリプトのものかが分かる名前で名乗る** (Issue #101)。
 * **置き方は独立したボタン** (`PageMenu.addMenu`。Issue #122)。ハンバーガーを開かずに 1 クリックで草に行け、
 * **アイコンで「数えていない / 未サインイン / 送っている」が分かる** (`menu-icon.ts`)。占有は 1 つのまま。
 * **「設定」はそのダイアログから開く** (段階 8、Issue #73・#79)。
 * サインイン (段階 4、Issue #61) は単独のメニューをやめ、「設定」に集約した (design §9)。
 * 「設定」には**この端末の切り離し**と**このブラウザの記録の削除**も載せている。
 * サーバのデータの管理 (端末の一覧・共有 URL・全削除) は Worker の `/account` (ADR-0018、Issue #88)。
 *
 * 開発用だった**送信の疎通確認** (Issue #31) と**センサーの記録** (Issue #36) のメニューは、v1 を配るのに合わせて消した (Issue #95)。
 * 疎通確認は本物の送信が入って役目を終えている。Worker 側の `/v1/probe.gif` は残っているので、手で叩けば確かめられる。
 */
import { generateSigningKeyPair } from "../shared/sign.ts";
import { AUTH_POPUP_FEATURES, AUTH_POPUP_NAME, createSignIn } from "./auth.ts";
import { CLEAR_TEXT, type Cleaner, createCleaner } from "./cleaner.ts";
import { createGraphDialog, type GraphDialog } from "./graph-dialog.ts";
import { requestImage } from "./image.ts";
import { createIndexedDbDeviceStore } from "./keys.ts";
import { describeMenuState, type MenuState, menuIcon } from "./menu-icon.ts";
import { SEND_TEXT, SEND_TEXT_FALLBACK } from "./outbox.ts";
import { createRevoker, REVOKE_TEXT, type Revoker } from "./revoke.ts";
import { createSender, type Sender } from "./sender.ts";
import { type Sensor, type SensorCosense, startExclusive, startSensor } from "./sensor.ts";
import { describeSettings, MENU_TITLE } from "./settings.ts";
import { createSettingsDialog, type SettingsDialog } from "./settings-dialog.ts";
import { createSettings, type SettingsAccess } from "./settings-store.ts";
import { createDialogView } from "./sign-in-dialog.ts";
import { createStore } from "./store.ts";
import { describeIntegrated, describeSync, type IntegratedView } from "./viewer.ts";

/**
 * 配布バンドルの版。**配布ページ `/cosense-grass/v1` に対応する** (Issue #95)。
 *
 * **番号を上げるのは、利用者が import の 1 行を書き直さないと動かなくなるときだけ** (ADR-0019)。
 * 見えるものが減るだけの変更は同じページを差し替え、minor を上げる。
 */
export const USERSCRIPT_VERSION = "1.2.0";

/** UserScript から使う `window.scrapbox` のうち、ここで触る部分だけ (research §2)。 */
export type Cosense = SensorCosense & {
  /**
   * プロジェクトが変わった (research §2)。**ページ遷移では出ない**ので、
   * 数えているかどうかが変わりうるときだけ呼ばれる
   */
  on(event: "project:changed", listener: () => void): void;
  readonly PageMenu: {
    /**
     * `div.page-menu` に独立したボタンを足す (research §2)。**`title` は tooltip であり、
     * ボタンの要素の `id` にもなる**ので、状態で変えない。`image` は data: URI でよい
     */
    addMenu(menu: { title: string; image: string; onClick: () => void }): void;
  };
};

export type Dependencies = {
  /**
   * サインインしてこの端末を登録する。**「設定」の onClick から同期で呼ぶ** (ポップアップを開くのに
   * クリックの直後である必要がある)
   */
  readonly signIn: () => Promise<string>;
  readonly sender: Pick<Sender, "trigger" | "status">;
  readonly graphDialog: Pick<GraphDialog, "open">;
  readonly settingsDialog: Pick<SettingsDialog, "open">;
  /** この端末の登録を取り消す */
  readonly revoker: Revoker;
  /** このブラウザの記録を消す */
  readonly cleaner: Cleaner;
  /** 設定の読み書き。**開くたびに読み直す** (別のタブで変えた値を拾う) */
  readonly settings: Pick<SettingsAccess, "read">;
  /** センサーを始める。同じタブで動いている前のセンサーは止める */
  readonly startSensor: () => Sensor;
  readonly document: Pick<Document, "addEventListener" | "visibilityState">;
  /** センサーの導入判定が終わるのを待ち直すのに使う (`checking` の間) */
  readonly setTimeout: (handler: () => void, ms: number) => number;
  readonly now: () => Date;
};

/** 導入判定 (`checking`) が終わるのを待ち直す間隔と回数。3 秒で諦め、次のきっかけに任せる */
const RECHECK_MS = 500;
const RECHECK_LIMIT = 6;

export function start(cosense: Cosense, deps: Dependencies): void {
  const sensor = deps.startSensor();

  // **足すのはこのボタン 1 つだけ。** 「設定」はこのダイアログから開く (Issue #95・#122)
  const button = startMenuButton(cosense, sensor, deps);

  void deps.sender.trigger("load");
  // **隠すたびに送る。** 変化が無ければ送らず、当日分は 1 日 4 回まで (sender.ts)
  deps.document.addEventListener("visibilitychange", () => {
    if (deps.document.visibilityState === "hidden") {
      void deps.sender.trigger("hidden");
    }
  });
  // **プロジェクトを移ってもボタンは残る** (research §2 の常駐)。移った先で数えているかは違うので描き直す
  cosense.on("project:changed", () => button.refresh());
}

/** アイコンを描き直す口。状態が変わるたびに `refresh()` を呼ぶ */
type MenuButton = { refresh: () => void };

/**
 * ページメニューのボタンを置き、状態に合わせてアイコンを描き直す (Issue #122)。
 *
 * **最初は `unknown` の絵ですぐ置く。** 状態を待ってから置くと、その間ボタンが無くて押せない。
 * 絵は後から正す。
 *
 * **描き直しは同じ `title` で `addMenu` を呼び直す。** `addMenu` は内部で `emitChange` するので
 * 反映される見込み (research §2)。**重複して増えるかは実機で確かめる** — そうなったら
 * この関数の `show` だけを DOM の差し替えに変えればよい。
 */
function startMenuButton(
  cosense: Cosense,
  sensor: Pick<Sensor, "status">,
  deps: Dependencies,
): MenuButton {
  let shown: MenuState | undefined;
  let rechecks = 0;

  const show = (state: MenuState) => {
    if (state === shown) {
      return;
    }
    shown = state;
    cosense.PageMenu.addMenu({
      title: MENU_TITLE,
      image: menuIcon(state),
      onClick: () => void runViewMenu(cosense, deps, button),
    });
  };

  const refresh = () => {
    const counting = sensor.status();
    void deps.sender.status().then(
      (send) => {
        show(describeMenuState(counting, send));
        // 導入判定が飛んでいる最中。終わったら描き直す
        if (counting === "checking" && rechecks < RECHECK_LIMIT) {
          rechecks += 1;
          deps.setTimeout(refresh, RECHECK_MS);
        }
      },
      // 読めないときは今の絵のまま。次のきっかけで読み直す
      () => undefined,
    );
  };

  const button: MenuButton = { refresh };
  show("unknown");
  refresh();
  return button;
}

/** 開くたびに登録の状態と設定を読み直す (別のタブで登録・変更したものを拾う) */
async function runSettingsDialog(deps: Dependencies, button: MenuButton): Promise<void> {
  const status = await deps.sender.status();
  deps.settingsDialog.open(describeSettings(status, deps.settings.read()), {
    // ポップアップを開くのは signIn の同期区間。登録できたら、貯まっていた記録と今日の分を送る
    signIn: () => {
      void deps.signIn().then((outcome) => {
        if (outcome === "added" || outcome === "known") {
          void deps.sender.trigger("enrolled");
        }
        // 登録できても失敗しても、アイコンが示す状態は変わりうる
        button.refresh();
      });
    },
    // **この端末を切り離したら未サインインに戻る。** 記録の削除ではアイコンは変わらない
    revoke: async () => {
      const text = REVOKE_TEXT[await deps.revoker.revokeThisDevice()];
      button.refresh();
      return text;
    },
    clear: async () => CLEAR_TEXT[deps.cleaner.clearLocalRecords()],
  });
}

/** 押すたびに鍵と送信の記録を読み直す (別のタブで登録・送信したものを拾う) */
async function runViewMenu(
  cosense: Cosense,
  deps: Dependencies,
  button: MenuButton,
): Promise<void> {
  const project = cosense.Project.name;
  let integrated: IntegratedView;
  try {
    integrated = describeIntegrated(await deps.sender.status(), project, deps.now());
  } catch {
    integrated = {
      kind: "message",
      lines: ["草の一覧を作れませんでした。ページを開き直して、もう一度押してください。"],
    };
  }
  deps.graphDialog.open(integrated, {
    // 押された時点で草のダイアログは閉じている。設定は自分で状況を読み直す
    openSettings: () => void runSettingsDialog(deps, button),
    // **送った後に状況を読み直す。** ダイアログを開き直さず、状態行だけ差し替えてもらう
    sendNow: async () => {
      const outcome = await deps.sender.trigger("manual");
      return {
        text: SEND_TEXT[outcome] ?? SEND_TEXT_FALLBACK,
        view: describeSync(await deps.sender.status(), deps.now()),
        // サーバの記録が変わったときだけ取り直す (変わっていなければ同じ絵になる)
        refresh: outcome === "written",
      };
    },
  });
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
    revoker: createRevoker({ keys, sendImage: (url) => requestImage(url), now: () => new Date() }),
    cleaner: createCleaner({ storage: window.localStorage }),
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
    document: window.document,
    setTimeout: (handler, ms) => window.setTimeout(handler, ms),
    now: () => new Date(),
  });
}
