import { describe, expect, it } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { sha256Hex } from "../../src/shared/hash.ts";
import {
  isValidKid,
  isValidPh,
  isValidUid,
  KID_LENGTH,
  kidOf,
  PH_ALL,
  PH_LENGTH,
  PUBLIC_ID_LENGTH,
  phOf,
  publicIdOf,
  UID_BYTES,
} from "../../src/shared/ids.ts";

// **このファイルは 2 つの project 両方の include に入っていて、workerd と jsdom で
// 2 回走る。** Worker が出す SVG と DOM 注入の草で判定が食い違わないことを、
// 同じ 1 つの検証で保証するため (片方のコピーを直し忘れる形にしない)。

const UID = encodeBase64url(new Uint8Array(UID_BYTES).fill(7));

describe("shared/ids", () => {
  it("桁数の定数が 16 である", () => {
    expect(PH_LENGTH).toBe(16);
  });

  it("16 桁の 16 進数を受け入れる", () => {
    expect(isValidPh("0123456789abcdef")).toBe(true);
  });

  it("12 桁は拒否する", () => {
    // ADR-0007 の改訂で 12 桁から 16 桁へ広げた。古い桁数を通してはいけない
    expect(isValidPh("0123456789ab")).toBe(false);
  });

  it("大文字は拒否する", () => {
    // 同じプロジェクトが 2 行に分かれるのを防ぐため
    expect(isValidPh("0123456789ABCDEF")).toBe(false);
  });

  it("合算の予約値を受け入れる", () => {
    expect(isValidPh(PH_ALL)).toBe(true);
  });

  it("空文字と 16 進数でない文字を拒否する", () => {
    expect(isValidPh("")).toBe(false);
    expect(isValidPh("0123456789abcdeg")).toBe(false);
  });
});

describe("uid", () => {
  it("**20 バイト (160 bit) の base64url で 27 文字** (ADR-0013 決定 2)", () => {
    expect(UID.length).toBe(27);
    expect(isValidUid(UID)).toBe(true);
  });

  it("長さの違うものと、末尾の余りビットが立った別表記を拒否する", () => {
    expect(isValidUid(UID.slice(0, 26))).toBe(false);
    expect(isValidUid(`${UID}A`)).toBe(false);
    expect(isValidUid(encodeBase64url(new Uint8Array(32)))).toBe(false);
    // 27 文字目は下位 2 bit が余る。"A" (0) の代わりに "B" (1) にすると非正規
    const zero = encodeBase64url(new Uint8Array(UID_BYTES));
    expect(isValidUid(zero)).toBe(true);
    expect(isValidUid(`${zero.slice(0, 26)}B`)).toBe(false);
  });
});

describe("ph", () => {
  it("SHA-256(uid + ':' + プロジェクト名) の先頭 16 桁", async () => {
    expect(await phOf(UID, "my-project")).toBe(await sha256Hex(`${UID}:my-project`, PH_LENGTH));
    expect(isValidPh(await phOf(UID, "my-project"))).toBe(true);
  });

  it("**uid でソルトされている** (同じプロジェクト名でも uid が違えば別の値)", async () => {
    const other = encodeBase64url(new Uint8Array(UID_BYTES).fill(8));
    expect(await phOf(UID, "my-project")).not.toBe(await phOf(other, "my-project"));
  });
});

describe("publicId", () => {
  it("全体用は SHA-256(uid + ':*')、プロジェクト用は SHA-256(uid + ':' + ph) の先頭 32 桁", async () => {
    const ph = await phOf(UID, "my-project");
    expect(PUBLIC_ID_LENGTH).toBe(32);
    expect(await publicIdOf(UID, PH_ALL)).toBe(await sha256Hex(`${UID}:*`, 32));
    expect(await publicIdOf(UID, ph)).toBe(await sha256Hex(`${UID}:${ph}`, 32));
  });

  it("**プロジェクト用と全体用は別の値で、ph をそのまま含まない** (一方向の導出。ADR-0007 決定 3)", async () => {
    const ph = await phOf(UID, "my-project");
    const project = await publicIdOf(UID, ph);
    expect(project).not.toBe(await publicIdOf(UID, PH_ALL));
    expect(project).not.toContain(ph);
    expect(project).not.toContain(UID);
  });
});

describe("kid", () => {
  it("公開鍵の**バイト列**の SHA-256 の先頭 16 桁", async () => {
    const publicKey = new Uint8Array(65).fill(4);
    const kid = await kidOf(publicKey);
    expect(kid).toBe(await sha256Hex(publicKey, KID_LENGTH));
    expect(isValidKid(kid)).toBe(true);
  });

  it("65 バイトでない公開鍵は RangeError", () => {
    expect(() => kidOf(new Uint8Array(64))).toThrow(RangeError);
  });

  it("16 桁の小文字 16 進数だけを受け入れる", () => {
    expect(isValidKid("0123456789abcdef")).toBe(true);
    expect(isValidKid("0123456789ABCDEF")).toBe(false);
    expect(isValidKid("0123456789abcde")).toBe(false);
  });
});
