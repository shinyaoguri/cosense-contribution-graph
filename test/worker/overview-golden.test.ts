/**
 * 活動の概観の SVG の本文を、既知の答え (SHA-256) で固定する (草の `svg-golden.test.ts` と同じ考え方)。
 *
 * 本文が変わると ETag も変わり、共有 SVG のキャッシュが入れ替わる (ADR-0015 決定 2)。
 * **描画を意図して変える PR は、ここの答えを更新し、見た目の証跡 (Gyazo) を PR に貼る。**
 */
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/shared/hash.ts";
import { demoOverviewDays } from "../../src/worker/demo.ts";
import { type OverviewTotals, sumOverview } from "../../src/worker/graph/overview.ts";
import { DEFAULT_SCHEME, type Theme } from "../../src/worker/graph/scheme.ts";
import { renderOverview } from "../../src/worker/overview-svg.ts";

function render(totals: OverviewTotals, theme: Theme = "light") {
  return renderOverview({ totals, theme, palette: DEFAULT_SCHEME });
}

const demo = () => sumOverview(demoOverviewDays().values());
const ZERO: OverviewTotals = { grow: 0, create: 0, join: 0, read: 0 };

const CASES: readonly (readonly [string, () => string, string])[] = [
  [
    "デモ (ライト)",
    () => render(demo()),
    "fdf7594dec9114bf9d1dcca948ee57086bb323f9ecaaaba1db4a1f3395fe8328",
  ],
  [
    "デモ (ダーク)",
    () => render(demo(), "dark"),
    "ba871034ae576b4fbf45d3fdad08a71c94874800286b8897d50830335da954d7",
  ],
  [
    "1 軸だけ",
    () => render({ ...ZERO, read: 10 }),
    "f9ded7d97bb2a1204994e06e57e6bc297c1d6715fb9b0273c32d8737f6887ad1",
  ],
  [
    "全部 0",
    () => render(ZERO),
    "7734ce1c253cd6d83d1ddc29217129a51db7e8b2ccf2351a86f3985d50cca5dc",
  ],
];

describe("活動の概観の SVG の本文 (ゴールデン)", () => {
  it.each(CASES)("%s", async (_name, draw, expected) => {
    expect(await sha256Hex(draw())).toBe(expected);
  });
});
