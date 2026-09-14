/**
 * SHA-256 の 16 進。
 *
 * **Worker と UserScript の両方で型検査される。** `crypto.subtle` は workerd にもブラウザにもあるので、
 * どちらの lib でも通る。
 */

const HEX_LENGTH = 64;

/**
 * SHA-256 を小文字の 16 進で返す。`length` 桁で切る (既定は全桁)。
 * 文字列は UTF-8 にしてからハッシュする。バイト列 (公開鍵など) はそのまま。
 */
export async function sha256Hex(
  input: string | Uint8Array<ArrayBuffer>,
  length = HEX_LENGTH,
): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}
