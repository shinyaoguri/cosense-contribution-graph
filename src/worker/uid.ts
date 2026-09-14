/**
 * Google の `sub` から uid を導く (design §3、ADR-0011)。
 *
 * ```
 * uid = HMAC-SHA256(WORKER_SECRET, "google:" + sub) の先頭 160 bit を base64url (27 文字)
 * ```
 *
 * **HMAC の鍵は `WORKER_SECRET` の文字列を UTF-8 にしたバイト列そのもの。** 16 進としてデコードしない。
 * `openssl rand -hex 32` で作った値でも、64 文字の文字列として扱う。
 * **この取り決めを変えると全員の uid が変わり、元に戻せない。**
 *
 * `sub` は保存しない。Worker 固有の秘密で HMAC するので、第三者は他人の uid を計算できない。
 */
import { encodeBase64url } from "../shared/base64url.ts";
import { UID_BYTES } from "../shared/ids.ts";

const UID_CONTEXT = "google:";

export async function uidOf(secret: string, sub: string): Promise<string> {
  // 空の秘密で導くと、誰でも uid を計算できてしまう
  if (secret.length === 0 || sub.length === 0) {
    throw new RangeError("secret と sub は空にできない");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(UID_CONTEXT + sub));
  return encodeBase64url(new Uint8Array(mac, 0, UID_BYTES));
}
