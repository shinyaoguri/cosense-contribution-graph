/**
 * Google サインインの取り決め (design §3「サインインのフロー」)。Worker の `/auth/callback` が作り、UserScript が読む。
 *
 * **コード** は uid (20 バイト) と登録トークン (16 バイト) を並べた 36 バイトの base64url で、48 文字。
 * ポップアップは `postMessage` で送ったうえで同じコードを画面にも出す。COOP で opener が切れたときは
 * 利用者がこれを貼る (design §3「COOP が enforced になったときのフォールバック」)。
 * **postMessage で受け取った値も、手で貼られた値も `parseAuthCode` 1 本で読む。**
 *
 * 両 lib で型検査され、両環境でテストされる。
 */
import { decodeBase64url, encodeBase64url } from "./base64url.ts";
import { ENROLL_TOKEN_BYTES, isValidEnrollToken } from "./enroll.ts";
import { isValidUid, UID_BYTES } from "./ids.ts";

export const AUTH_START_PATH = "/auth/start";
export const AUTH_CALLBACK_PATH = "/auth/callback";

/** ポップアップが postMessage を送る先。**`"*"` にしない** (コードを他のオリジンへ渡さない) */
export const AUTH_OPENER_ORIGIN = "https://scrapbox.io";

/** postMessage の `type`。他の拡張や UserScript のメッセージと取り違えない */
export const AUTH_MESSAGE_TYPE = "cosense-grass:auth";

const CODE_BYTES = UID_BYTES + ENROLL_TOKEN_BYTES;

/** コードの長さ。36 バイトは 3 で割り切れるので余りビットが無く、正規形の判定はデコードだけで済む */
export const AUTH_CODE_LENGTH = (CODE_BYTES * 4) / 3;

export type AuthCode = {
  readonly uid: string;
  /** 登録トークン (base64url 22 文字) */
  readonly token: string;
};

/** コードを作る。形が取り決めの外なら RangeError。 */
export function encodeAuthCode(code: AuthCode): string {
  const uid = isValidUid(code.uid) ? decodeBase64url(code.uid) : undefined;
  const token = isValidEnrollToken(code.token) ? decodeBase64url(code.token) : undefined;
  if (uid === undefined || token === undefined) {
    throw new RangeError("uid か登録トークンの形が違う");
  }
  const bytes = new Uint8Array(CODE_BYTES);
  bytes.set(uid, 0);
  bytes.set(token, UID_BYTES);
  return encodeBase64url(bytes);
}

/** コードを読む。前後の空白 (貼り付けで入る改行) は落とす。形が違えば `undefined`。 */
export function parseAuthCode(text: string): AuthCode | undefined {
  const trimmed = text.trim();
  if (trimmed.length !== AUTH_CODE_LENGTH) {
    return undefined;
  }
  const bytes = decodeBase64url(trimmed);
  if (bytes?.length !== CODE_BYTES) {
    return undefined;
  }
  return {
    uid: encodeBase64url(bytes.subarray(0, UID_BYTES)),
    token: encodeBase64url(bytes.subarray(UID_BYTES)),
  };
}
