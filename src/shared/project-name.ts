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
