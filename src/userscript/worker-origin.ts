/**
 * UserScript が話しかける本番の Worker。
 *
 * **独自ドメイン** (ADR-0014 決定 10)。`cosense-grass.soui.workers.dev` も有効のまま残しているが、UserScript からは使わない。
 * サインインのポップアップの postMessage も、このオリジンから来たものだけを受け取る。
 */
import { ACCOUNT_PATH } from "../shared/auth.ts";
import type { GuideName } from "../shared/guide.ts";
import { PH_ALL, phOf, publicIdOf } from "../shared/ids.ts";
import { PRIVACY_JA_PATH } from "../shared/links.ts";
import { isValidProjectName, isValidUserName } from "../shared/project-name.ts";

export const WORKER_ORIGIN = "https://grass.soui.dev";

/** 管理のページ (ADR-0017・0018)。**リンクを開くだけ**で、中身は UserScript から読めない。 */
export const ACCOUNT_URL = `${WORKER_ORIGIN}${ACCOUNT_PATH}`;

/** プライバシーポリシー。草のダイアログの下端から開く。**ダイアログが日本語なので日本語版** (ADR-0022) */
export const PRIVACY_URL = `${WORKER_ORIGIN}${PRIVACY_JA_PATH}`;

/**
 * プロジェクト (省けば合算) の `ph` と、その図の `publicId` (草・概観・カードで共通)。
 *
 * **導き方をここ 1 か所に置く** (#72・ADR-0025)。ダイアログに並べる URL (`sender.ts` の status) と、
 * プロフィールページに貼る図の URL・貼ってあるかの判定 (`profile.ts`) が同じ値を使う。
 * 片方だけ変わると、貼った図と見せている図が別物になり、判定が外れて貼り続ける。
 * **`shared/ids.ts` に置かないのは UserScript しか使わないから** (design §2。Worker はプロジェクト名を持たない)
 */
export async function graphIds(
  uid: string,
  projectName?: string,
): Promise<{ readonly ph: string; readonly publicId: string }> {
  const ph = projectName === undefined ? PH_ALL : await phOf(uid, projectName);
  return { ph, publicId: await publicIdOf(uid, ph) };
}

/** カードの行のリンク先。**UserScript が動いているオリジン** (scrapbox.io) */
const COSENSE_ORIGIN = "https://scrapbox.io";

/** 図に描く名前。**サーバは保存しない** (ADR-0007) */
type Names = { readonly project?: string; readonly user?: string };

/**
 * 図の URL に付ける版。Worker はクエリを見ないので、図の中身には効かない。
 *
 * **ブラウザに残った古い図を避けるためのもの** (#186)。図は当初 `max-age=86400` で配っていたので、
 * 配色を変えた後も (#185)、一度開いたブラウザには古い図が残り、強制再読み込みでも取り直されなかった
 * (ダイアログの `<img>` は後から差し込むため)。今は `no-cache` で毎回確かめ直させるので、
 * **図を変えるたびに上げる必要は無い**。もう一度 `max-age` を付けたときにだけ上げる
 */
const GUIDE_REVISION = "2";

/**
 * 草のダイアログの説明に添える図 (Issue #182)。**描くのは Worker** (ADR-0019) で、ここは `<img>` の URL を作るだけ
 */
export function guideUrl(name: GuideName): string {
  return `${WORKER_ORIGIN}/v1/guide/${name}.svg?v=${GUIDE_REVISION}`;
}

/**
 * 共有 SVG の URL (design §6)。
 *
 * **プロジェクト名を渡すと `?l=`、ユーザー名を渡すと `u=` を付ける** (Issue #119・#134)。
 * Worker はどちらも保存せず、その画像に描くだけ。
 * **貼った先でも名前が出る**ようにするため、`<img>` だけでなくコピーする URL にも同じものを使う。
 * 形が取り決めの外なら付けない (Worker 側も同じ形で弾くので、付けても描かれない)。
 */
export function graphUrl(publicId: string, names: Names = {}): string {
  return withNames(`${WORKER_ORIGIN}/v1/g/${publicId}.svg`, names);
}

/** 名前を `?l=` / `u=` で付ける。形が取り決めの外なら付けない (草とカードで共通) */
function withNames(url: string, names: Names): string {
  const query = [
    names.project !== undefined && isValidProjectName(names.project)
      ? `l=${encodeURIComponent(names.project)}`
      : undefined,
    names.user !== undefined && isValidUserName(names.user)
      ? `u=${encodeURIComponent(names.user)}`
      : undefined,
  ].filter((part) => part !== undefined);
  return query.length === 0 ? url : `${url}?${query.join("&")}`;
}

/**
 * カードの図の URL (design §6、ADR-0024)。**草と同じ publicId** で、名前の付け方も草と同じ。
 *
 * プロフィールページに貼る行 (`cardLine`) と、ダイアログの `<img>` に使う
 */
export function cardUrl(publicId: string, names: Names = {}): string {
  return withNames(`${WORKER_ORIGIN}/v1/g/${publicId}/card.svg`, names);
}

/**
 * Cosense に貼るカードの行 (ADR-0025 決定 6 の改訂)。**ただの画像の記法** `[<図の URL>]` で、リンク先は付けない。
 *
 * ```
 * [https://grass.soui.dev/v1/g/<publicId>/card.svg?l=<project>&u=<user>]
 * ```
 *
 * - 最初はリンク付きの画像 (`[<図の URL> https://scrapbox.io/<project>/]`) にしていたが、作者が不要と判断した (2026-10-07、#213)。
 *   プロジェクトへのリンクは SVG の中のプロジェクト名が持つ (SVG を直接開いたときに効く)
 * - 角括弧の中に空白と `]` が入ると記法が切れる。名前は `encodeURIComponent` を通すので入らない
 *   (Cosense の記法の判定は `@progfay/scrapbox-parser` の `ImageNode.ts`。URL が `.svg` で終わり、続くクエリに空白と `]` が無いこと)
 */
export function cardLine(publicId: string, names: Names = {}): string {
  return `[${cardUrl(publicId, names)}]`;
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
