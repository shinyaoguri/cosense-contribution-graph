/**
 * UserScript のエントリ。Cosense のユーザーページから 1 行で import される
 * バンドルの入口 (ADR-0005)。
 *
 * 今は**送信の疎通確認**だけを載せている (Issue #31)。センサーは段階 5、DOM 注入と設定 UI は段階 8。
 */
import { PH_ALL } from "../shared/ids.ts";
import { describeResult, type ProbeResult, runProbe } from "./probe.ts";

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
export type Cosense = {
  readonly Project: { readonly name: string };
  readonly PageMenu: {
    addItem(item: { title: string; onClick: () => void }): void;
  };
};

export const PROBE_MENU_TITLE = "草: 送信の疎通確認";

/** 1 日分のビットマップ (180 バイト)、分割のしきい値 (design §9)、Cloudflare の上限の近く。 */
export const PROBE_SIZES = [240, 8_000, 15_000] as const;

/** タブを隠したときに送った結果。**プロジェクト名はこのブラウザにだけ持つ** (design §9)。 */
export const HIDDEN_PROBE_KEY = "cosense-grass:probe:hidden";

const HIDDEN_PROBE_SIZE = 240;

type HiddenRecord = { readonly project: string; readonly at: string; readonly result: ProbeResult };

export type Dependencies = {
  readonly runProbe: (length: number) => Promise<ProbeResult>;
  readonly alert: (message: string) => void;
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly document: Pick<Document, "addEventListener" | "visibilityState">;
  readonly now: () => Date;
};

export function start(cosense: Cosense, deps: Dependencies): void {
  cosense.PageMenu.addItem({
    title: PROBE_MENU_TITLE,
    onClick: () => void runMenu(cosense, deps),
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
    void deps.runProbe(HIDDEN_PROBE_SIZE).then((result) => {
      const record: HiddenRecord = { project, at, result };
      deps.storage.setItem(HIDDEN_PROBE_KEY, JSON.stringify(record));
    });
  });
}

async function runMenu(cosense: Cosense, deps: Dependencies): Promise<void> {
  const rows: { size: string; result: string }[] = [];
  // 大きい URL を同時に飛ばさないよう、順に送る
  for (const size of PROBE_SIZES) {
    rows.push({ size: `${size} 文字`, result: describeResult(await deps.runProbe(size)) });
  }

  const hidden = readHidden(deps.storage);
  rows.push({
    size: "タブを隠したとき",
    result: hidden
      ? `${describeResult(hidden.result)} (${hidden.project}, ${formatTime(hidden.at)})`
      : "まだ無い (タブを一度隠して戻ってから押す)",
  });

  console.table(rows);
  deps.alert(
    [
      `${PROBE_MENU_TITLE} (${cosense.Project.name}, ${formatTime(deps.now().toISOString())})`,
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
  start(window.scrapbox, {
    runProbe: (length) => runProbe(length),
    alert: (message) => window.alert(message),
    storage: window.localStorage,
    document: window.document,
    now: () => new Date(),
  });
}
