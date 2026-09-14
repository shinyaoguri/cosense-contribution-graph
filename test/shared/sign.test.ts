import { describe, expect, it } from "vitest";
import {
  exportPublicKey,
  generateSigningKeyPair,
  importVerifyKey,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  sign,
  signingInput,
  verify,
} from "../../src/shared/sign.ts";

// **ECDSA P-256 のラウンドトリップは段階 2 の未確認事項** (design §14)。ブラウザで sign して workerd で
// verify する形そのものは実機で確かめるが、両環境で同じ関数が往復することをここで固定する

describe("signingInput", () => {
  it("経路を先頭に置き、固定順の key=value を改行で並べる", () => {
    expect(
      signingInput("/v1/p.gif", [
        ["v", "1"],
        ["u", "uid"],
        ["t", "1789358609"],
      ]),
    ).toBe("/v1/p.gif\nv=1\nu=uid\nt=1789358609");
  });

  it("値は生のまま連結する (URL エンコードしない)", () => {
    expect(signingInput("/x", [["p", "a|b;c*"]])).toBe("/x\np=a|b;c*");
  });

  it("**改行を含む値は RangeError** (別のフィールドを偽造できるため)", () => {
    expect(() => signingInput("/x", [["u", "a\nt=1"]])).toThrow(RangeError);
    expect(() => signingInput("/x\ny", [])).toThrow(RangeError);
  });
});

describe("ECDSA P-256", () => {
  it("生成した鍵で sign → 書き出した公開鍵で verify が通る", async () => {
    const pair = await generateSigningKeyPair();
    const publicKey = await exportPublicKey(pair.publicKey);
    expect(publicKey.length).toBe(PUBLIC_KEY_BYTES);
    // 非圧縮 SEC1 の先頭は 0x04
    expect(publicKey[0]).toBe(0x04);

    const signature = await sign(pair.privateKey, "/v1/p.gif\nv=1");
    // r‖s 形式。DER (70〜72 バイト) ではない
    expect(signature.length).toBe(SIGNATURE_BYTES);

    const key = await importVerifyKey(publicKey);
    expect(await verify(key, signature, "/v1/p.gif\nv=1")).toBe(true);
  });

  it("**秘密鍵は書き出せない** (extractable: false)", async () => {
    const pair = await generateSigningKeyPair();
    expect(pair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", pair.privateKey)).rejects.toThrow();
  });

  it("中身が 1 文字でも違えば false", async () => {
    const pair = await generateSigningKeyPair();
    const key = await importVerifyKey(await exportPublicKey(pair.publicKey));
    const signature = await sign(pair.privateKey, "t=100");
    expect(await verify(key, signature, "t=101")).toBe(false);
  });

  it("別の鍵の署名は false", async () => {
    const pair = await generateSigningKeyPair();
    const other = await generateSigningKeyPair();
    const key = await importVerifyKey(await exportPublicKey(pair.publicKey));
    expect(await verify(key, await sign(other.privateKey, "x"), "x")).toBe(false);
  });

  it("**64 バイトでない署名は verify に渡す前に RangeError** (DER が静かに false になるのを防ぐ)", async () => {
    const pair = await generateSigningKeyPair();
    const key = await importVerifyKey(await exportPublicKey(pair.publicKey));
    expect(() => verify(key, new Uint8Array(63), "x")).toThrow(RangeError);
    expect(() => verify(key, new Uint8Array(71), "x")).toThrow(RangeError);
  });

  it("65 バイトでない公開鍵は RangeError", () => {
    expect(() => importVerifyKey(new Uint8Array(64))).toThrow(RangeError);
  });
});
