/**
 * Gyazo の画像 ID の形 (ADR-0028)。
 *
 * **図の URL の `?i=` で、UserScript が Worker にアイコンの手がかりを渡すときの取り決め。** 非公開プロジェクトのアイコンは
 * Worker が Cosense から引けないので、ログインしたブラウザの UserScript がページの `image` (`https://gyazo.com/<id>/raw`) から
 * ID だけを取り出して渡し、Worker はそこから `https://gyazo.com/<id>/max_size/64` を**自分で組み立てる**。
 * 渡された URL を取りに行く口は作らない。
 *
 * **URL の部品にするので、32 桁の小文字の 16 進数だけを通す。** `/` や `..` が混ざる余地を形で先に消す。
 * 両 lib で型検査され、両環境でテストされる。
 */
const PATTERN = /^[0-9a-f]{32}$/;

export function isValidGyazoId(text: string): boolean {
  return PATTERN.test(text);
}
