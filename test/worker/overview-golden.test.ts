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
import type { SchemeName, Theme } from "../../src/worker/graph/scheme.ts";
import { renderOverview } from "../../src/worker/overview-svg.ts";

function render(totals: OverviewTotals, theme: Theme = "light", palette: SchemeName = "blue-pink") {
  return renderOverview({ totals, theme, palette });
}

const demo = () => sumOverview(demoOverviewDays().values());
const ZERO: OverviewTotals = { grow: 0, create: 0, join: 0, read: 0 };

const CASES: readonly (readonly [string, () => string, string])[] = [
  [
    "デモ (ライト)",
    () => render(demo()),
    "9a498dbd61c5f27521806fee32ece49e8439b249cba4431fc85afbc9332847b2",
  ],
  [
    "デモ (ダーク)",
    () => render(demo(), "dark"),
    "d0cd7250e7780f8822948716d580ed57fb93fbb95146fdaae986e971c7857ec6",
  ],
  [
    "デモ (blue-yellow)",
    () => render(demo(), "light", "blue-yellow"),
    "23e32aa4c35dc07c985bebb3f3c15394858b5d360cb6a1715b8fb1e1d9182e85",
  ],
  [
    "1 軸だけ",
    () => render({ ...ZERO, read: 10 }),
    "cd05b597c7bf3545093859fc93fcc78d5f8b9eb00795ff19767a2bf6f660efd6",
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
