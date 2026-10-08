/**
 * UserScript が話しかける本番の Worker。
 *
 * **独自ドメイン** (ADR-0014 決定 10)。`cosense-grass.soui.workers.dev` も有効のまま残しているが、UserScript からは使わない。
 * サインインのポップアップの postMessage も、このオリジンから来たものだけを受け取る。
 */
import { ACCOUNT_PATH } from "../shared/auth.ts";
import { CARD_FORM, GRAPH_FORM, type GrassForm } from "../shared/grass.ts";
import type { GuideName } from "../shared/guide.ts";
import { isValidGyazoId } from "../shared/gyazo-id.ts";
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

/**
 * 図に描く名前。**サーバは保存しない** (ADR-0007)。
 * `icon` は Gyazo の画像 ID (ADR-0028)。非公開プロジェクトのアイコンを Worker が取るための手がかりで、`icon.ts` が読んだページから作る
 */
export type Names = {
  readonly project?: string;
  readonly user?: string;
  readonly icon?: string;
};

/** 図の形と、振り返る年 (`?year=`)。年があれば期間は 1 年になる (ADR-0026 決定 1) */
export type GrassView = GrassForm & { readonly year?: number };

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
 * 図の URL (design §6、ADR-0026)。`{publicId}.svg`・`card.svg` は同じ描画で既定の形だけが違うので、
 * **選んだ形を既定に持つ経路を選び、既定と違うキーだけを付ける** (貼る行を短く保つ)。どちらでもなければ `card.svg` に付ける。
 *
 * - **プロジェクト名を渡すと `l=`、ユーザー名を渡すと `u=` を付ける** (Issue #119・#134)。Worker はどちらも保存せず、その画像に描くだけ。
 *   **貼った先でも名前が出る**ようにするため、`<img>` だけでなくコピーする URL にも同じものを使う。
 *   形が取り決めの外なら付けない (Worker 側も同じ形で弾くので、付けても描かれない)
 * - **年を選んだら期間は 1 年** (Worker も `year` があれば 1 年で描く)。`span` は付けず `year` だけを付ける
 * - **`i=` (Gyazo の画像 ID。ADR-0028) は、`l=` と `u=` が付き、ID の形が正しいときだけ末尾に付ける。** Worker はアイコンを名前の行にしか描かず、
 *   取りに行くのも `l` と `u` がそろうときだけなので、それ以外に付けても URL が長くなるだけ
 */
export function grassUrl(publicId: string, view: GrassView, names: Names = {}): string {
  const span = view.year === undefined ? view.span : "year";
  const graph = span === GRAPH_FORM.span && view.cell === GRAPH_FORM.cell;
  const base = graph ? GRAPH_FORM : CARD_FORM;
  const project =
    names.project !== undefined && isValidProjectName(names.project) ? names.project : undefined;
  const user = names.user !== undefined && isValidUserName(names.user) ? names.user : undefined;
  const icon =
    project !== undefined &&
    user !== undefined &&
    names.icon !== undefined &&
    isValidGyazoId(names.icon)
      ? names.icon
      : undefined;
  const query = [
    view.year === undefined && span !== base.span ? `span=${span}` : undefined,
    view.cell !== base.cell ? `cell=${view.cell}` : undefined,
    view.year === undefined ? undefined : `year=${view.year}`,
    project === undefined ? undefined : `l=${encodeURIComponent(project)}`,
    user === undefined ? undefined : `u=${encodeURIComponent(user)}`,
    icon === undefined ? undefined : `i=${icon}`,
  ].filter((part) => part !== undefined);
  const url = `${WORKER_ORIGIN}/v1/g/${publicId}${graph ? ".svg" : "/card.svg"}`;
  return query.length === 0 ? url : `${url}?${query.join("&")}`;
}

/**
 * Cosense に貼る図の行 (ADR-0025 決定 6 の改訂)。**ただの画像の記法** `[<図の URL>]` で、リンク先は付けない。
 *
 * ```
 * [https://grass.soui.dev/v1/g/<publicId>/card.svg?l=<project>&u=<user>&i=<gyazo の画像 ID>]
 * ```
 *
 * - 最初はリンク付きの画像 (`[<図の URL> https://scrapbox.io/<project>/]`) にしていたが、作者が不要と判断した (2026-10-07、#213)。
 *   プロジェクトへのリンクは SVG の中のプロジェクト名が持つ (SVG を直接開いたときに効く)
 * - 角括弧の中に空白と `]` が入ると記法が切れる。名前は `encodeURIComponent` を通すので入らない
 *   (Cosense の記法の判定は `@progfay/scrapbox-parser` の `ImageNode.ts`。URL の path が `.svg` で終わり、続くクエリに空白と `]` が無いこと)
 */
export function grassLine(publicId: string, view: GrassView, names: Names = {}): string {
  return `[${grassUrl(publicId, view, names)}]`;
}

/** 1 年 × 1 日の図 (`{publicId}.svg`)。サインインした後に開く (`auth.ts`) */
export function graphUrl(publicId: string, names: Names = {}): string {
  return grassUrl(publicId, GRAPH_FORM, names);
}

/** カードの図 (`card.svg` の既定の形。ADR-0024)。プロフィールページに貼る (`profile.ts`。ADR-0025) */
export function cardUrl(publicId: string, names: Names = {}): string {
  return grassUrl(publicId, CARD_FORM, names);
}

/** プロフィールページに貼るカードの行。**クエリは名前だけで、形は既定のまま** (ADR-0026 の改訂。ダイアログで選んだ形は混ぜない) */
export function cardLine(publicId: string, names: Names = {}): string {
  return grassLine(publicId, CARD_FORM, names);
}

/**
 * 日ごとの集計値の JSON (design §6、ADR-0020)。**草の URL からは作れない `dataKey` を並べる。**
 * UserScript は uid を持つので、合算にもプロジェクト別にも作れる (ADR-0020 決定 3)
 */
export function dataUrl(publicId: string, dataKey: string): string {
  return `${WORKER_ORIGIN}/v1/g/${publicId}/${dataKey}.json`;
}
