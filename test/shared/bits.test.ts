import { describe, expect, it } from "vitest";
import {
  andNotBits,
  BITMAP_BYTES,
  bitmapOf,
  bitsEqual,
  isBitmap,
  MINUTES_PER_DAY,
  orBits,
  popcount,
} from "../../src/shared/bits.ts";

describe("ビットマップの形", () => {
  it("1 日 1440 分 = 180 バイト", () => {
    expect(MINUTES_PER_DAY).toBe(1440);
    expect(BITMAP_BYTES).toBe(180);
    expect(bitmapOf([]).length).toBe(180);
  });

  it("**0:00 はバイト 0 の最上位、23:59 はバイト 179 の最下位** (クライアントとサーバで並びを揃える)", () => {
    const first = bitmapOf([0]);
    expect(first[0]).toBe(0x80);
    expect(popcount(first)).toBe(1);

    const last = bitmapOf([1439]);
    expect(last[179]).toBe(0x01);
    expect(popcount(last)).toBe(1);

    expect(bitmapOf([8, 9, 15])[1]).toBe(0b1100_0001);
  });

  it("範囲外の分は RangeError", () => {
    expect(() => bitmapOf([-1])).toThrow(RangeError);
    expect(() => bitmapOf([1440])).toThrow(RangeError);
    expect(() => bitmapOf([1.5])).toThrow(RangeError);
  });

  it("180 バイトだけをビットマップとみなす", () => {
    expect(isBitmap(new Uint8Array(180))).toBe(true);
    expect(isBitmap(new Uint8Array(179))).toBe(false);
    expect(isBitmap(new Uint8Array(181))).toBe(false);
  });
});

describe("集合演算", () => {
  const a = bitmapOf([0, 1, 2, 700]);
  const b = bitmapOf([2, 3, 1439]);

  it("OR は和集合で、**同じものを何度 OR しても変わらない** (冪等)", () => {
    const merged = orBits(a, b);
    expect(popcount(merged)).toBe(6);
    expect(bitsEqual(orBits(merged, b), merged)).toBe(true);
    expect(bitsEqual(orBits(merged, merged), merged)).toBe(true);
  });

  it("OR は順序に依らない", () => {
    expect(bitsEqual(orBits(a, b), orBits(b, a))).toBe(true);
  });

  it("andNot は a から b と重なる分を除く (r & ~w)", () => {
    expect(bitsEqual(andNotBits(a, b), bitmapOf([0, 1, 700]))).toBe(true);
  });

  it("演算は入力を書き換えない", () => {
    const before = a.slice();
    orBits(a, b);
    andNotBits(a, b);
    expect(bitsEqual(a, before)).toBe(true);
  });

  it("popcount は全部立っていれば 1440", () => {
    expect(popcount(new Uint8Array(180).fill(0xff))).toBe(1440);
  });

  it("bitsEqual は 1 bit の違いを見分ける", () => {
    expect(bitsEqual(bitmapOf([5]), bitmapOf([5]))).toBe(true);
    expect(bitsEqual(bitmapOf([5]), bitmapOf([6]))).toBe(false);
  });
});
