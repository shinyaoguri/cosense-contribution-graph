/**
 * 草の SVG の本文を、既知の答え (SHA-256) で固定する。
 *
 * **描画を変えない変更 (レイアウトの計算を `src/shared/` へ移す、など) で、1 バイトも変わっていないことを確かめるためのもの。**
 * 本文が変わると ETag も変わり、共有 SVG のキャッシュが入れ替わる (ADR-0015 決定 2)。
 *
 * **描画を意図して変える PR は、ここの答えを更新し、見た目の証跡 (Gyazo) を PR に貼る。**
 * 答えだけを黙って書き換えない。
 */
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/shared/hash.ts";
import { DEMO_TODAY, demoData } from "../../src/worker/demo.ts";
import type { Minutes } from "../../src/worker/graph/balance.ts";
import { centerOf } from "../../src/worker/graph/balance.ts";
import { DEFAULT_PARAMS, type Params } from "../../src/worker/graph/grid.ts";
import { buildScale } from "../../src/worker/graph/scale.ts";
import { renderGraph } from "../../src/worker/svg.ts";

function demo(
  params: Partial<Params>,
  today = DEMO_TODAY,
  startDay?: string,
  label?: string,
): string {
  const { days, population } = demoData();
  return renderGraph({
    today,
    days,
    scale: buildScale(population.map((d) => d.w + d.r)),
    center: centerOf(population),
    startDay,
    label,
    params: { ...DEFAULT_PARAMS, ...params },
  });
}

function empty(): string {
  const population: Minutes[] = [];
  return renderGraph({
    today: DEMO_TODAY,
    days: new Map(),
    scale: buildScale([]),
    center: centerOf(population),
    params: DEFAULT_PARAMS,
  });
}

const CASES: readonly (readonly [string, () => string, string])[] = [
  [
    "デモ (ライト)",
    () => demo({}),
    "4ffbf2f4c794e6f4d76e1777051269e87bc6f8fd24ce801899a55f90361bd160",
  ],
  [
    "デモ (ダーク)",
    () => demo({ theme: "dark" }),
    "69866ff88de6d3f7cca40cfe1a7061f64f6822bdc9bb9db0317a41db6f0550b3",
  ],
  [
    "mode=write",
    () => demo({ mode: "write" }),
    "b5b3d8b349bdfa61053b6e7c46ff25829ef3fd0f2bfabb4c97950b07f25cb406",
  ],
  [
    "weeks=10",
    () => demo({ weeks: 10 }),
    "bafd7e698fe1b819970b270013998fd13f81e8ffd22e79657e64f3f8b56b70c4",
  ],
  [
    "weeks=1 (凡例の方が広い)",
    () => demo({ weeks: 1 }),
    "54f4a2af1d2e9483e74bed76dd2250ea1cd1af9c66073645f6cf057f579e3619",
  ],
  [
    "palette=blue-yellow (ダーク)",
    () => demo({ palette: "blue-yellow", theme: "dark" }),
    "2cc2fd95c90ec80f5260fe7fd7e6f3a0df3b1a469aa7426ef956b629e4f4e352",
  ],
  ["母集団が空", empty, "a694fee1e74d4d40761f2cdeefd6be29377ed2c0a5b698d950e57a7d82ec0acb"],
  [
    "計測開始の印 (Issue #80)",
    () => demo({}, DEMO_TODAY, "2026-06-01"),
    "06bc43c240d48e5d3da034f7e7d21d6e391938a0c1ae938237320952a575d42f",
  ],
  [
    "プロジェクト名とリンク (Issue #119)",
    () => demo({}, DEMO_TODAY, undefined, "villagepump"),
    "c343d1cf375982951e615289c3a4635b9155fbd9f12af01076df479a91cc68b3",
  ],
  [
    "今日が日曜",
    () => demo({}, "2026-09-13"),
    "b77c3cd5b3d2dec44720bf5d89ee436517b5ee1bd6cf70ab4fd96c771cf301c6",
  ],
  [
    "今日が土曜",
    () => demo({}, "2026-09-12"),
    "5af6b533a2b4377e8a8e90cc6ca381da4f467ec73e66f19b5ce794e80c8f1973",
  ],
];

describe("草の SVG の本文 (既知の答え)", () => {
  it.each(CASES)("%s", async (_, render, expected) => {
    expect(await sha256Hex(render())).toBe(expected);
  });
});
