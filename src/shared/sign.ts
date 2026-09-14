/**
 * 署名対象の正規化と ECDSA P-256 の署名・検証 (design §3、ADR-0009)。UserScript と Worker が同じコードを使う。
 *
 * **`URLSearchParams.toString()` を署名対象にしない。** 空白が `+` になる、エンコード集合が実装で違う、
 * 順序が不定、重複キーの扱いが未定義。代わりに固定順・固定フィールドの改行区切りにする。
 *
 * ```
 * 署名対象 = "<経路>\nv=1\nu=<uid>\nd=<kid>\nt=<unix秒>\np=<p の生の値>"
 * ```
 *
 * **先頭に経路を入れる** (2026-09-14 改訂)。design §3 の当初の形には無く、段階 4 の
 * `/v1/revoke.gif` や `/v1/delete.gif` に同じ署名を使い回されうる。
 *
 * 両 lib で型検査され、両環境でテストされる。
 */

/** ECDSA P-256 の署名は r‖s で 64 バイト固定。ブラウザの sign も workerd の verify もこの形。 */
export const SIGNATURE_BYTES = 64;

/** 公開鍵は 65 バイトの非圧縮 SEC1 (`importKey("raw", ...)` の形)。 */
export const PUBLIC_KEY_BYTES = 65;

const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN_ALGORITHM = { name: "ECDSA", hash: "SHA-256" } as const;

/**
 * 署名対象の文字列。
 *
 * 値は生のまま連結する (URL に乗せるときだけエンコードする)。**区切りの改行が値に入ると
 * 別のフィールドを偽造できるので、改行を含む値は RangeError にする。** 受け口は値の形を
 * 正規表現で先に確かめるので、ここに改行が届くのはコードの誤りだけ。
 */
export function signingInput(path: string, fields: readonly (readonly [string, string])[]): string {
  const lines = [path, ...fields.map(([key, value]) => `${key}=${value}`)];
  if (lines.some((line) => line.includes("\n"))) {
    throw new RangeError("署名対象の値に改行を含めない");
  }
  return lines.join("\n");
}

/**
 * 秘密鍵を持ち出せない鍵ペアを作る (`extractable: false`)。公開鍵は常に書き出せる。
 * UserScript はこれを IndexedDB に `CryptoKey` のまま保存する (design §3)。
 */
export async function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  // workerd の型は CryptoKey との合併型を返すので、形で絞る
  const pair = await crypto.subtle.generateKey(KEY_ALGORITHM, false, ["sign", "verify"]);
  if (!("privateKey" in pair)) {
    throw new TypeError("ECDSA の generateKey が鍵ペアを返さなかった");
  }
  return pair;
}

export async function exportPublicKey(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  // workerd の型は JsonWebKey との合併型を返す。instanceof は jsdom で realm が違うと外れるので形で見る
  const raw = await crypto.subtle.exportKey("raw", key);
  if (!("byteLength" in raw)) {
    throw new TypeError("公開鍵を raw で書き出せなかった");
  }
  return new Uint8Array(raw);
}

/** 65 バイトの非圧縮 SEC1 を検証用に読み込む。**usage は verify だけ** (公開鍵の制約)。 */
export function importVerifyKey(publicKey: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (publicKey.length !== PUBLIC_KEY_BYTES) {
    throw new RangeError(`公開鍵は ${PUBLIC_KEY_BYTES} バイト: ${publicKey.length}`);
  }
  return crypto.subtle.importKey("raw", publicKey, KEY_ALGORITHM, false, ["verify"]);
}

export async function sign(privateKey: CryptoKey, input: string): Promise<Uint8Array<ArrayBuffer>> {
  const signature = await crypto.subtle.sign(
    SIGN_ALGORITHM,
    privateKey,
    new TextEncoder().encode(input),
  );
  return new Uint8Array(signature);
}

/**
 * 署名を検証する。
 *
 * **64 バイトでなければ RangeError。** DER (70〜72 バイト) を渡すと workerd は例外でなく静かに
 * `false` を返すので、「署名が違う」と「形が違う」を取り違える (ADR-0009)。受け口は形の段で
 * 先に弾く。
 */
export function verify(
  publicKey: CryptoKey,
  signature: Uint8Array<ArrayBuffer>,
  input: string,
): Promise<boolean> {
  if (signature.length !== SIGNATURE_BYTES) {
    throw new RangeError(`署名は ${SIGNATURE_BYTES} バイト: ${signature.length}`);
  }
  return crypto.subtle.verify(
    SIGN_ALGORITHM,
    publicKey,
    signature,
    new TextEncoder().encode(input),
  );
}
