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

function demo(params: Partial<Params>, today = DEMO_TODAY, startDay?: string): string {
  const { days, population } = demoData();
  return renderGraph({
    today,
    days,
    scale: buildScale(population.map((d) => d.w + d.r)),
    center: centerOf(population),
    startDay,
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
    "d8a790969b0e7cfe8b21ea442b480c14b06c9a8f99dcbdc61566ed8bdd9656b3",
  ],
  [
    "デモ (ダーク)",
    () => demo({ theme: "dark" }),
    "ba7a03c1ecc5f9f42206ce8a9dfb239f29c7a426ac8291d014ed0849f71e1e42",
  ],
  [
    "mode=write",
    () => demo({ mode: "write" }),
    "ec412e8c6300ac41db2202d9a5a447e265396bcf0d032b0f4ad79bc13fa84a0b",
  ],
  [
    "weeks=10",
    () => demo({ weeks: 10 }),
    "9b9c849fdfb64f18e7190932ad3769aa13f1f64ac676275f183cf8965d27f6d9",
  ],
  [
    "weeks=1 (凡例の方が広い)",
    () => demo({ weeks: 1 }),
    "54f4a2af1d2e9483e74bed76dd2250ea1cd1af9c66073645f6cf057f579e3619",
  ],
  [
    "palette=blue-yellow (ダーク)",
    () => demo({ palette: "blue-yellow", theme: "dark" }),
    "3841eeae71b92fe30872f673a671b419e32a14b718e2fb3f281e1021f6f8153a",
  ],
  ["母集団が空", empty, "33d5ea747bc1c45ce3941067595b94618cc72a8cf9fc81b1c002ce5d91c57868"],
  [
    "計測開始の印 (Issue #80)",
    () => demo({}, DEMO_TODAY, "2026-06-01"),
    "bde0aef4ae25e3155a640d5bd5f116bb0fd6df1829d3c7162082bdeda976c705",
  ],
  [
    "今日が日曜",
    () => demo({}, "2026-09-13"),
    "b3eaa501c460865c48e78ec3ea72c747b9254a04b5c1e0d890bc3cbb31f9ce4d",
  ],
  [
    "今日が土曜",
    () => demo({}, "2026-09-12"),
    "bd142e0f6cd5ad504a6eae3899d7c4f2cde033b47a02aa15654038786f0abf2c",
  ],
];

describe("草の SVG の本文 (既知の答え)", () => {
  it.each(CASES)("%s", async (_, render, expected) => {
    expect(await sha256Hex(render())).toBe(expected);
  });
});
