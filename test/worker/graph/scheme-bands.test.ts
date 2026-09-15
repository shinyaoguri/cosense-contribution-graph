import { describe, expect, it } from "vitest";
import { bandScheme } from "../../../src/worker/graph/schemes/bands.ts";
import { bluePink } from "../../../src/worker/graph/schemes/blue-pink.ts";

// 表で色を指定するスキーム。スキームに共通の性質は scheme.test.ts が見る

/** 列ごとに色を変えた 3 列の表。どの列に入ったかを色で読み取れるようにする。 */
function ramp(prefix: string) {
  return [`${prefix}0001`, `${prefix}0002`, `${prefix}0003`, `${prefix}0004`] as const;
}

const spec = {
  name: "test",
  bands: [
    { light: ramp("#aa"), dark: ramp("#dd") },
    { light: ramp("#bb"), dark: ramp("#ee") },
    { light: ramp("#cc"), dark: ramp("#ff") },
  ],
  edges: [-0.5, 0.5],
  level0: { light: "#eeeeee", dark: "#111111" },
  legendBalances: [-1, 0, 1],
};

const scheme = bandScheme(spec);

function columnPrefix(balance: number): string {
  return scheme.cell({ level: 1, balance, total: 99 }, "light").slice(0, 3);
}

describe("列の振り分け", () => {
  it("バランスの範囲で列が決まる", () => {
    expect(columnPrefix(-1)).toBe("#aa");
    expect(columnPrefix(0)).toBe("#bb");
    expect(columnPrefix(1)).toBe("#cc");
  });

  it("**境界ちょうどは小さい側 (読み寄り) の列**", () => {
    expect(columnPrefix(-0.5)).toBe("#aa");
    expect(columnPrefix(-0.4999)).toBe("#bb");
    expect(columnPrefix(0.5)).toBe("#bb");
    expect(columnPrefix(0.5001)).toBe("#cc");
  });

  it("Level で列の中の段を選ぶ", () => {
    expect(
      ([1, 2, 3, 4] as const).map((level) =>
        scheme.cell({ level, balance: 0, total: 99 }, "light"),
      ),
    ).toEqual(ramp("#bb"));
  });

  it("テーマで表を切り替える", () => {
    expect(scheme.cell({ level: 4, balance: 1, total: 99 }, "dark")).toBe("#ff0004");
  });

  it("Level 0 はバランスによらずテーマの固定色", () => {
    for (const balance of [-1, 0, 1]) {
      expect(scheme.cell({ level: 0, balance, total: 99 }, "light")).toBe("#eeeeee");
      expect(scheme.cell({ level: 0, balance, total: 99 }, "dark")).toBe("#111111");
    }
  });

  it("合計分数は色に効かない (手で選んだ色をそのまま使う)", () => {
    expect(scheme.cell({ level: 2, balance: 0, total: 3 }, "light")).toBe(
      scheme.cell({ level: 2, balance: 0, total: Number.POSITIVE_INFINITY }, "light"),
    );
  });
});

describe("表の書き間違いは作るときに落とす", () => {
  it("境界の数が列の数 − 1 でない", () => {
    expect(() => bandScheme({ ...spec, edges: [0] })).toThrow(RangeError);
    expect(() => bandScheme({ ...spec, edges: [-0.5, 0, 0.5] })).toThrow(RangeError);
  });

  it("境界が昇順でない", () => {
    expect(() => bandScheme({ ...spec, edges: [0.5, -0.5] })).toThrow(RangeError);
    expect(() => bandScheme({ ...spec, edges: [0, 0] })).toThrow(RangeError);
  });
});

describe("blue-pink", () => {
  /** `#rrggbb` の赤と青のチャネル。 */
  function redBlue(hex: string): { red: number; blue: number } {
    const n = Number.parseInt(hex.slice(1), 16);
    return { red: (n >> 16) & 255, blue: n & 255 };
  }

  it("凡例の見本 5 つがそれぞれ別の列に入る", () => {
    for (const theme of ["light", "dark"] as const) {
      const colors = bluePink.legendBalances.map((balance) =>
        bluePink.cell({ level: 4, balance, total: 99 }, theme),
      );
      expect(new Set(colors).size, theme).toBe(5);
    }
  });

  it("読み寄りは青、書き寄りはピンク", () => {
    for (const theme of ["light", "dark"] as const) {
      const read = redBlue(bluePink.cell({ level: 4, balance: -1, total: 99 }, theme));
      const write = redBlue(bluePink.cell({ level: 4, balance: 1, total: 99 }, theme));
      expect(read.blue, theme).toBeGreaterThan(read.red);
      expect(write.red, theme).toBeGreaterThan(write.blue);
    }
  });
});
