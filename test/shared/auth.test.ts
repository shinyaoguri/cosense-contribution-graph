import { describe, expect, it } from "vitest";
import {
  AUTH_CODE_LENGTH,
  type AuthCode,
  encodeAuthCode,
  parseAuthCode,
} from "../../src/shared/auth.ts";
import { encodeBase64url } from "../../src/shared/base64url.ts";

const CODE: AuthCode = {
  uid: encodeBase64url(new Uint8Array(20).fill(0)),
  token: encodeBase64url(new Uint8Array(16).fill(0xff)),
};

describe("encodeAuthCode と parseAuthCode", () => {
  it("**48 文字で、uid とトークンを並べただけの形** (既知の答え)", () => {
    const text = encodeAuthCode(CODE);
    expect(text).toHaveLength(AUTH_CODE_LENGTH);
    expect(AUTH_CODE_LENGTH).toBe(48);
    // 0x00 が 20 バイト (160 bit = 26 文字と 4 bit) + 0xff が 16 バイト。
    // python3 -c "import base64; print(base64.urlsafe_b64encode(bytes(20) + b'\xff' * 16))"
    expect(text).toBe(`${"A".repeat(26)}D${"_".repeat(21)}`);
  });

  it("往復で元に戻る", () => {
    const code = {
      uid: encodeBase64url(crypto.getRandomValues(new Uint8Array(20))),
      token: encodeBase64url(crypto.getRandomValues(new Uint8Array(16))),
    };
    expect(parseAuthCode(encodeAuthCode(code))).toEqual(code);
  });

  it("貼り付けで入る前後の空白と改行は落とす", () => {
    expect(parseAuthCode(`  ${encodeAuthCode(CODE)}\n`)).toEqual(CODE);
  });

  it.each([
    ["47 文字", (text: string) => text.slice(0, 47)],
    ["49 文字", (text: string) => `${text}A`],
    ["途中に空白", (text: string) => `${text.slice(0, 24)} ${text.slice(25)}`],
    ["通常の base64 の +", (text: string) => `+${text.slice(1)}`],
    ["通常の base64 の /", (text: string) => `/${text.slice(1)}`],
    ["パディング", (text: string) => `${text.slice(0, 47)}=`],
  ])("%s は読まない", (_, mutate) => {
    expect(parseAuthCode(mutate(encodeAuthCode(CODE)))).toBeUndefined();
  });

  it("形の違う uid やトークンからは作らない", () => {
    expect(() => encodeAuthCode({ ...CODE, uid: "short" })).toThrow(RangeError);
    expect(() => encodeAuthCode({ ...CODE, token: `${CODE.token}A` })).toThrow(RangeError);
  });
});
