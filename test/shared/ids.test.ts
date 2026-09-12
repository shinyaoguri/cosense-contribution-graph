import { describe, expect, it } from "vitest";
import { isValidPh, PH_ALL, PH_LENGTH } from "../../src/shared/ids.ts";

// **このファイルは 2 つの project 両方の include に入っていて、workerd と jsdom で
// 2 回走る。** Worker が出す SVG と DOM 注入の草で判定が食い違わないことを、
// 同じ 1 つの検証で保証するため (片方のコピーを直し忘れる形にしない)。

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
