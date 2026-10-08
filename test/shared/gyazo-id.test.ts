import { describe, expect, it } from "vitest";
import { isValidGyazoId } from "../../src/shared/gyazo-id.ts";

describe("Gyazo の画像 ID の形 (ADR-0028)", () => {
  it("32 桁の小文字の 16 進数を通す", () => {
    expect(isValidGyazoId("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isValidGyazoId("f".repeat(32))).toBe(true);
  });

  it("**桁数が違うもの・大文字・16 進数でない文字は通さない**", () => {
    for (const id of [
      "",
      "0".repeat(31),
      "0".repeat(33),
      "ABCDEF0123456789ABCDEF0123456789",
      "g".repeat(32),
      `${"0".repeat(31)} `,
    ]) {
      expect(isValidGyazoId(id), id).toBe(false);
    }
  });

  it("**URL の区切りと相対パスは通さない** (ID から URL を組み立てるので、ここが塞ぎどころ)", () => {
    for (const id of [
      "../../etc/passwd",
      `${"0".repeat(30)}/x`,
      `${"0".repeat(30)}..`,
      `${"0".repeat(31)}?`,
      `${"0".repeat(31)}#`,
      `${"0".repeat(32)}\n`,
    ]) {
      expect(isValidGyazoId(id), id).toBe(false);
    }
  });
});
