/**
 * UserScript のエントリ。Cosense のユーザーページから 1 行で import される
 * バンドルの入口 (ADR-0005)。
 *
 * 段階 0 は骨組みだけ。センサーは段階 5、DOM 注入と設定 UI は段階 8。
 */
import { PH_ALL } from "../shared/ids.ts";

/**
 * 配布バンドルの版。
 *
 * **破壊的変更のときは配布ページを分ける** (README のバージョン運用)。
 * 同一パスの中身を差し替えてよいのはバグ修正だけ。
 */
export const USERSCRIPT_VERSION = "0.0.0";

/** 合算の草を指す識別子。段階 8 の表示で使う。 */
export const AGGREGATE_PH = PH_ALL;
