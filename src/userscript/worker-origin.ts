/**
 * UserScript が話しかける本番の Worker。
 *
 * **独自ドメイン** (ADR-0014 決定 10)。`cosense-grass.soui.workers.dev` も有効のまま残しているが、UserScript からは使わない。
 * サインインのポップアップの postMessage も、このオリジンから来たものだけを受け取る。
 */
import { ACCOUNT_PATH } from "../shared/auth.ts";

export const WORKER_ORIGIN = "https://grass.soui.dev";

/** 管理のページ (ADR-0017・0018)。**リンクを開くだけ**で、中身は UserScript から読めない。 */
export const ACCOUNT_URL = `${WORKER_ORIGIN}${ACCOUNT_PATH}`;

/** 共有 SVG の URL (design §6)。 */
export function graphUrl(publicId: string): string {
  return `${WORKER_ORIGIN}/v1/g/${publicId}.svg`;
}
