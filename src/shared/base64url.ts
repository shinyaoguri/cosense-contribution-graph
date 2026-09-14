/**
 * パディングなしの base64url (RFC 4648 §5)。ビーコンの uid・署名・公開鍵・ビットマップに使う。
 *
 * **デコードは厳密にする。** 同じバイト列に対して文字列が 1 つに決まる形 (正規形) だけを受け付ける。
 * 署名は URL の文字列そのものに付くので、末尾の余りビットだけが違う別の文字列を通すと、
 * 1 つの記録に複数の見た目が生まれる。`atob` は余りビットを見ないので使わない。
 *
 * 両 lib で型検査され、両環境でテストされる。
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const VALUE_OF = new Map([...ALPHABET].map((char, i) => [char, i]));

export function encodeBase64url(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const chunk = (a << 16) | (b << 8) | c;
    // 残りが 1 バイトなら 2 文字、2 バイトなら 3 文字
    const chars = Math.min(bytes.length - i, 3) + 1;
    for (let j = 0; j < chars; j++) {
      text += ALPHABET[(chunk >> (18 - 6 * j)) & 63];
    }
  }
  return text;
}

/**
 * base64url をバイト列にする。正規形でなければ `undefined`。
 *
 * - パディング (`=`) と、`+` `/` を含む通常の base64 は拒否する
 * - 長さを 4 で割って 1 余る文字列は、どのバイト列にも対応しないので拒否する
 * - **末尾の余りビットが 0 でなければ拒否する** (2 文字余りなら下位 4 bit、3 文字余りなら下位 2 bit)
 */
export function decodeBase64url(text: string): Uint8Array<ArrayBuffer> | undefined {
  const rest = text.length % 4;
  if (rest === 1) {
    return undefined;
  }

  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of text) {
    const value = VALUE_OF.get(char);
    if (value === undefined) {
      return undefined;
    }
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (buffer >> bits) & 0xff;
    }
  }

  // 使われなかった下位ビット
  if ((buffer & ((1 << bits) - 1)) !== 0) {
    return undefined;
  }
  return bytes;
}
