import { describe, expect, it } from "vitest";
import { decodeBase64url, encodeBase64url } from "../../src/shared/base64url.ts";

// ビーコンの署名は URL の文字列に付くので、UserScript が書いた文字列を Worker が同じバイト列に
// 読むことが前提になる。両環境で走らせる

const bytes = (...values: number[]) => new Uint8Array(values);
// TextEncoder は使わない。jsdom では返る Uint8Array の realm が違い、toEqual が中身を見ずに外れる
const ascii = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));

describe("encodeBase64url", () => {
  it("RFC 4648 のテストベクタをパディングなしで返す", () => {
    expect(encodeBase64url(ascii(""))).toBe("");
    expect(encodeBase64url(ascii("f"))).toBe("Zg");
    expect(encodeBase64url(ascii("fo"))).toBe("Zm8");
    expect(encodeBase64url(ascii("foo"))).toBe("Zm9v");
    expect(encodeBase64url(ascii("foob"))).toBe("Zm9vYg");
    expect(encodeBase64url(ascii("fooba"))).toBe("Zm9vYmE");
    expect(encodeBase64url(ascii("foobar"))).toBe("Zm9vYmFy");
  });

  it("62・63 番目の文字は - と _ (URL で安全な表)", () => {
    expect(encodeBase64url(bytes(0xfb, 0xff))).toBe("-_8");
  });
});

describe("decodeBase64url", () => {
  it("0〜70 バイトの乱数が往復する", () => {
    for (let length = 0; length <= 70; length++) {
      const original = crypto.getRandomValues(new Uint8Array(length));
      expect(decodeBase64url(encodeBase64url(original))).toEqual(original);
    }
  });

  it("RFC 4648 のテストベクタを読む", () => {
    expect(decodeBase64url("Zm9vYmE")).toEqual(ascii("fooba"));
    expect(decodeBase64url("-_8")).toEqual(bytes(0xfb, 0xff));
  });

  it("パディングと通常の base64 の文字を拒否する", () => {
    expect(decodeBase64url("Zg==")).toBeUndefined();
    expect(decodeBase64url("+/8")).toBeUndefined();
    expect(decodeBase64url("Zm 9")).toBeUndefined();
    expect(decodeBase64url("Zm9v草")).toBeUndefined();
  });

  it("4 で割って 1 余る長さは、どのバイト列にも対応しないので拒否する", () => {
    expect(decodeBase64url("Z")).toBeUndefined();
    expect(decodeBase64url("Zm9vY")).toBeUndefined();
  });

  it("**末尾の余りビットが立っていれば拒否する** (同じバイト列の別表記を通さない)", () => {
    // "f" の正規形は Zg。Zh〜Zv は下位 4 bit だけが違う
    expect(decodeBase64url("Zg")).toEqual(ascii("f"));
    expect(decodeBase64url("Zh")).toBeUndefined();
    expect(decodeBase64url("Zv")).toBeUndefined();
    // "fo" の正規形は Zm8。Zm9 は下位 2 bit が違う
    expect(decodeBase64url("Zm8")).toEqual(ascii("fo"));
    expect(decodeBase64url("Zm9")).toBeUndefined();
  });
});
