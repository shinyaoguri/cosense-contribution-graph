/**
 * UserScript が話しかける本番の Worker。
 *
 * **独自ドメイン** (ADR-0014 決定 10)。`cosense-grass.soui.workers.dev` も有効のまま残しているが、UserScript からは使わない。
 * サインインのポップアップの postMessage も、このオリジンから来たものだけを受け取る。
 */
import { ACCOUNT_PATH } from "../shared/auth.ts";
import { PRIVACY_JA_PATH } from "../shared/links.ts";
import { isValidProjectName, isValidUserName } from "../shared/project-name.ts";

export const WORKER_ORIGIN = "https://grass.soui.dev";

/** 管理のページ (ADR-0017・0018)。**リンクを開くだけ**で、中身は UserScript から読めない。 */
export const ACCOUNT_URL = `${WORKER_ORIGIN}${ACCOUNT_PATH}`;

/** プライバシーポリシー。草のダイアログの下端から開く。**ダイアログが日本語なので日本語版** (ADR-0022) */
export const PRIVACY_URL = `${WORKER_ORIGIN}${PRIVACY_JA_PATH}`;

/**
 * 共有 SVG の URL (design §6)。
 *
 * **プロジェクト名を渡すと `?l=`、ユーザー名を渡すと `u=` を付ける** (Issue #119・#134)。
 * Worker はどちらも保存せず、その画像に描くだけ。
 * **貼った先でも名前が出る**ようにするため、`<img>` だけでなくコピーする URL にも同じものを使う。
 * 形が取り決めの外なら付けない (Worker 側も同じ形で弾くので、付けても描かれない)。
 */
export function graphUrl(
  publicId: string,
  names: { readonly project?: string; readonly user?: string } = {},
): string {
  const query = [
    names.project !== undefined && isValidProjectName(names.project)
      ? `l=${encodeURIComponent(names.project)}`
      : undefined,
    names.user !== undefined && isValidUserName(names.user)
      ? `u=${encodeURIComponent(names.user)}`
      : undefined,
  ].filter((part) => part !== undefined);
  const url = `${WORKER_ORIGIN}/v1/g/${publicId}.svg`;
  return query.length === 0 ? url : `${url}?${query.join("&")}`;
}

/**
 * 活動の概観の URL (design §6、ADR-0021)。**草と同じ publicId** で、草の横 (下) に並べる。
 * 名前 (`l` / `u`) は描かないので付けない。
 */
export function overviewUrl(publicId: string): string {
  return `${WORKER_ORIGIN}/v1/g/${publicId}/overview.svg`;
}

/**
 * 日ごとの集計値の JSON (design §6、ADR-0020)。**草の URL からは作れない `dataKey` を並べる。**
 * UserScript は uid を持つので、合算にもプロジェクト別にも作れる (ADR-0020 決定 3)
 */
export function dataUrl(publicId: string, dataKey: string): string {
  return `${WORKER_ORIGIN}/v1/g/${publicId}/${dataKey}.json`;
}
