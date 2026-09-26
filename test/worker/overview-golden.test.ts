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
    "08330a6211cb495a8cb3ad2f39bc73b9d8714c67b71be96d53e2ce14b3de18f7",
  ],
  [
    "デモ (ダーク)",
    () => render(demo(), "dark"),
    "4f93b995cbb7468f1c091f161cbf4dfc5200019e7e27fd5243386cefdb1812bd",
  ],
  [
    "デモ (blue-yellow)",
    () => render(demo(), "light", "blue-yellow"),
    "caa026893bde5dbd1fd8d14374940c41838af4c4e7441d26a523eea0b5dba9b3",
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
