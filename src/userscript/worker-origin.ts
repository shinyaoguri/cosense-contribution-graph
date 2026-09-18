/**
 * UserScript が話しかける本番の Worker。
 *
 * **独自ドメイン** (ADR-0014 決定 10)。`cosense-grass.soui.workers.dev` も有効のまま残しているが、UserScript からは使わない。
 * サインインのポップアップの postMessage も、このオリジンから来たものだけを受け取る。
 */
import { ACCOUNT_PATH } from "../shared/auth.ts";
import { isValidProjectName } from "../shared/project-name.ts";

export const WORKER_ORIGIN = "https://grass.soui.dev";

/** 管理のページ (ADR-0017・0018)。**リンクを開くだけ**で、中身は UserScript から読めない。 */
export const ACCOUNT_URL = `${WORKER_ORIGIN}${ACCOUNT_PATH}`;

/**
 * 共有 SVG の URL (design §6)。
 *
 * **プロジェクト名を渡すと `?l=` を付ける** (Issue #119)。Worker はこれを保存せず、その画像に描くだけ。
 * **貼った先でも名前が出る**ようにするため、`<img>` だけでなくコピーする URL にも同じものを使う。
 * 形が取り決めの外なら付けない (Worker 側も同じ形で弾くので、付けても描かれない)。
 */
export function graphUrl(publicId: string, projectName?: string): string {
  const url = `${WORKER_ORIGIN}/v1/g/${publicId}.svg`;
  return projectName !== undefined && isValidProjectName(projectName)
    ? `${url}?l=${encodeURIComponent(projectName)}`
    : url;
}
