import { describe, expect, it } from "vitest";
import {
  type ColorScheme,
  DEFAULT_SCHEME,
  isSchemeName,
  SCHEMES,
  type Theme,
} from "../../src/shared/scheme.ts";

// **全スキームの契約テスト。** 登録表 SCHEMES に配色を足すと、ここで自動的に確かめられる

const LEVELS = [0, 1, 2, 3, 4] as const;
const THEMES: readonly Theme[] = ["light", "dark"];
const BALANCES = [-1, -0.6, -0.2, 0, 0.2, 0.6, 1];
const TOTALS = [3, 15, 90, Number.POSITIVE_INFINITY];

/** 相対輝度 (WCAG)。明るさの向きを比べるのに使う。 */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => lin(c / 255));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

describe("登録表", () => {
  it("既定のスキームが登録されている", () => {
    expect(Object.keys(SCHEMES)).toContain(DEFAULT_SCHEME);
  });

  it("スキームの名前は登録表のキーと一致する (クエリの値として使うため)", () => {
    for (const [key, scheme] of Object.entries(SCHEMES)) {
      expect(scheme.name).toBe(key);
    }
  });

  it("登録済みの名前だけをスキーム名とみなす", () => {
    for (const name of Object.keys(SCHEMES)) {
      expect(isSchemeName(name), name).toBe(true);
    }
    // 継承したキーを通さない (`in` で見ると通る)
    for (const value of [
      null,
      "",
      "unknown",
      "BLUE-PINK",
      "toString",
      "__proto__",
      "constructor",
    ]) {
      expect(isSchemeName(value), String(value)).toBe(false);
    }
  });
});

describe.each(Object.values(SCHEMES) as ColorScheme[])("スキーム $name の契約", (scheme) => {
  it("全 Level × バランス × 合計分数 × テーマで #rrggbb を返す", () => {
    for (const theme of THEMES) {
      for (const level of LEVELS) {
        for (const balance of BALANCES) {
          for (const total of TOTALS) {
            expect(scheme.cell({ level, balance, total }, theme)).toMatch(/^#[0-9a-f]{6}$/);
          }
        }
      }
    }
  });

  it("凡例の見本が 1 つ以上あり、-1 .. +1 に収まる", () => {
    expect(scheme.legendBalances.length).toBeGreaterThan(0);
    for (const balance of scheme.legendBalances) {
      expect(balance).toBeGreaterThanOrEqual(-1);
      expect(balance).toBeLessThanOrEqual(1);
    }
  });

  it("Level 0 は Level 1〜4 のどれとも違う色", () => {
    for (const theme of THEMES) {
      const level0 = scheme.cell({ level: 0, balance: 0, total: 99 }, theme);
      for (const level of [1, 2, 3, 4] as const) {
        expect(scheme.cell({ level, balance: 0, total: 99 }, theme)).not.toBe(level0);
      }
    }
  });

  it("Level が上がると、ライトは暗く、ダークは明るくなる (GitHub と同じ向き)", () => {
    for (const balance of scheme.legendBalances) {
      const lum = (theme: Theme) =>
        ([1, 2, 3, 4] as const).map((level) =>
          luminance(scheme.cell({ level, balance, total: Number.POSITIVE_INFINITY }, theme)),
        );
      const light = lum("light");
      const dark = lum("dark");
      for (let i = 1; i < 4; i++) {
        expect(light[i], `light balance=${balance}`).toBeLessThan(light[i - 1] ?? 0);
        expect(dark[i], `dark balance=${balance}`).toBeGreaterThan(dark[i - 1] ?? 0);
      }
    }
  });
});
