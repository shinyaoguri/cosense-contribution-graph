/**
 * Cosense のプロジェクト名の形 (research §2、2026-09-17 に記録)。
 *
 * > Name can contain only alphabets, numbers and hyphens. It must start and end with alphabet or number
 *
 * **草の画像にプロジェクト名を描くときの許可リスト** (ADR-0007 決定 2 の 2026-09-18 の再改訂、Issue #119)。
 * 名前はクエリ `?l=` で渡され、**サーバは保存しない**。受け取った文字列をそのまま SVG に描くので、
 * ここを通ったものだけを描く。
 *
 * **通す文字に `<` `&` `"` が無いことが XSS を塞ぐ要点。** `escapeXml` も通すが、
 * そこに頼らずこの形で先に落とす (ADR-0007 決定 2 が却下した「エスケープの規定がない」状態を作らない)。
 *
 * 両 lib で型検査され、両環境でテストされる。
 */

/**
 * 描くことを許す長さの上限。**Cosense 側の上限は確かめていない**ので、こちらで決める。
 * 実在するプロジェクト名より十分長く、草の幅 (53 週で 775px) の中で凡例に届かない長さ。
 */
export const MAX_PROJECT_NAME_LENGTH = 64;

/** 英字・数字・ハイフン。**先頭と末尾は英字か数字** (ハイフンで始まらず、ハイフンで終わらない)。 */
const PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

export function isValidProjectName(text: string): boolean {
  return text.length <= MAX_PROJECT_NAME_LENGTH && PATTERN.test(text);
}

/**
 * ユーザー名の長さの上限 (書記素で数える。Issue #195)。実測の最長は 16 (research §2、2026-09-29)。
 * 全角で並べても草の幅の見積もり (`layout.ts` の `projectWidth`) が扱える長さにしている
 */
export const MAX_USER_NAME_LENGTH = 48;

/** 書記素と別に、UTF-16 の長さでも抑える。結合文字を重ねると 1 書記素のまま URL を膨らませられるため */
const MAX_USER_NAME_UNITS = 256;

/**
 * 表示を壊すので通さない文字。制御文字 (Cc)・行と段落の区切り (Zl・Zp)・片割れのサロゲート (Cs。
 * `encodeURIComponent` が投げる)・双方向の制御文字 (後ろの凡例まで並びを反転させうる)。
 * **ZWJ・異体字セレクタ・タグ文字は通す** — 絵文字の合成に使う
 */
const USER_NAME_FORBIDDEN =
  /[\p{Cc}\p{Zl}\p{Zp}\p{Cs}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const segmenter = new Intl.Segmenter();

/** 書記素の数。絵文字の ZWJ の列や旗は 1 つに数える */
function graphemeCount(text: string): number {
  let count = 0;
  for (const _ of segmenter.segment(text)) {
    count += 1;
  }
  return count;
}

/**
 * Cosense のユーザー名の形 (Issue #134・#195)。**草の画像に `@<名前>` として描くときの取り決め。**
 * 名前はクエリ `?u=` で渡され、プロジェクト名と同じく**サーバは保存しない**。
 *
 * **プロジェクト名と違い、表示を壊す文字だけを拒む。** ユーザー名には漢字・かな・空白・`_` が普通に使われる
 * (research §2 の 2026-09-29 の実測。1 プロジェクトの 63 人のうち 48 人が英数字とハイフンに収まらない)。
 * `<` `&` `"` も通すので、**描く側の `escapeXml` が XSS を塞ぐ要点になる** (ADR-0007 決定 2 の 2026-09-29 の改訂)。
 * SVG の応答には `Content-Security-Policy: default-src 'none'` も付く
 */
export function isValidUserName(text: string): boolean {
  return (
    text.trim() !== "" &&
    text.length <= MAX_USER_NAME_UNITS &&
    !USER_NAME_FORBIDDEN.test(text) &&
    graphemeCount(text) <= MAX_USER_NAME_LENGTH
  );
}
