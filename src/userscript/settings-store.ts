/**
 * 設定を localStorage に置く (design §9「保存するもの」、段階 8、Issue #79)。
 *
 * ```
 * cosense-grass:settings  { v: 1, countRead: boolean }
 * ```
 *
 * - **read 計上の on/off は全体で 1 つ。** プロジェクト単位にはしない (design §9「設定 UI」)
 * - **知らない版の設定があれば書かない** (`store.ts`・`outbox.ts` と同じ約束。新しい版のバンドルが
 *   別のタブで書いた形を壊さない)
 * - ただし**読む方は知らない版でも `countRead` を尊重する。** これは「数えないでほしい」という意思表示なので、
 *   版が新しいことを理由に数え始める方が害が大きい
 * - **押すたび・数えるたびに読み直す。** localStorage はオリジン単位で、別のプロジェクトのタブとも共有される
 */
export const SETTINGS_KEY = "cosense-grass:settings";

/** 設定の形の版。 */
export const SETTINGS_VERSION = 1;

export type Settings = {
  readonly v: typeof SETTINGS_VERSION;
  /** 読みを数えるか。**既定は数える** (数えないと草の色が書きだけになる) */
  readonly countRead: boolean;
};

export const DEFAULT_SETTINGS: Settings = { v: SETTINGS_VERSION, countRead: true };

export type SettingsRead = {
  readonly settings: Settings;
  /** 知らない版の設定がある。**この状態では書かない** (読んだ値は使う) */
  readonly newer: boolean;
};

type WriteOutcome =
  | "written"
  /** 知らない版の設定があるので書かなかった */
  | "blocked"
  /** 書き込みが例外になった (容量超過など) */
  | "failed";

export type SettingsAccess = {
  read(): SettingsRead;
  setCountRead(value: boolean): WriteOutcome;
};

/** 設定を読む。壊れていれば既定。 */
export function readSettings(storage: Pick<Storage, "getItem">): SettingsRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storage.getItem(SETTINGS_KEY) ?? "null");
  } catch {
    return { settings: DEFAULT_SETTINGS, newer: false };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { settings: DEFAULT_SETTINGS, newer: false };
  }
  const record = parsed as Record<string, unknown>;
  const newer = typeof record.v === "number" && record.v > SETTINGS_VERSION;
  // 知らない版でも countRead が読めれば使う (数えないでほしい、という意思表示を版で覆さない)
  const countRead = typeof record.countRead === "boolean" ? record.countRead : true;
  return { settings: { v: SETTINGS_VERSION, countRead }, newer };
}

/** 書く。知らない版があれば書かない。 */
export function writeSettings(
  storage: Pick<Storage, "getItem" | "setItem">,
  settings: Settings,
): WriteOutcome {
  if (readSettings(storage).newer) {
    return "blocked";
  }
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return "written";
  } catch {
    return "failed";
  }
}

export function createSettings(storage: Pick<Storage, "getItem" | "setItem">): SettingsAccess {
  return {
    read: () => readSettings(storage),
    setCountRead: (value) => writeSettings(storage, { ...DEFAULT_SETTINGS, countRead: value }),
  };
}
