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
import type { Minutes } from "../../src/shared/balance.ts";
import { centerOf } from "../../src/shared/balance.ts";
import { DEFAULT_PARAMS, type Params } from "../../src/shared/graph.ts";
import { sha256Hex } from "../../src/shared/hash.ts";
import { buildScale } from "../../src/shared/scale.ts";
import { DEMO_TODAY, demoData } from "../../src/worker/demo.ts";
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
    "a090d3643e98ce05dedf9047fbef058cd602e5414379b5a85f668fbb79384495",
  ],
  [
    "デモ (ダーク)",
    () => demo({ theme: "dark" }),
    "cd41d844ab8d6714ce104aad8cdcfc04058d41d7f13492dcff2870b8a4196286",
  ],
  [
    "mode=write",
    () => demo({ mode: "write" }),
    "6df3723e25ecbb7f5a7b10c46e383f561baaf9fe406f389862a1b147551aa7b3",
  ],
  [
    "weeks=10",
    () => demo({ weeks: 10 }),
    "3e77a7515d93133cdb429d03e64e92800b91122d8aafb363bc57dc06581b9b3f",
  ],
  [
    "weeks=1 (凡例の方が広い)",
    () => demo({ weeks: 1 }),
    "386d5f4c974ee03f67dcc3329836ef02864e720b7a892bda8c63c7cb0d1049e9",
  ],
  [
    "palette=blue-yellow (ダーク)",
    () => demo({ palette: "blue-yellow", theme: "dark" }),
    "9a1a1b9f3308e7d70c0478040b79bf27acae59d944dc0afdf490b851f0195e66",
  ],
  ["母集団が空", empty, "0c16a2a38b02a93443d32a87218ac2a7c3cc504d8168a59688e9d1276451a408"],
  [
    "計測開始の印 (Issue #80)",
    () => demo({}, DEMO_TODAY, "2026-06-01"),
    "fc62fe8a3a29aab33acb21831c26c7905503467ac7b3bef9b71fc24594738a56",
  ],
  [
    "今日が日曜",
    () => demo({}, "2026-09-13"),
    "0b7eae2c8d1675937cb140e5661598304949a4935b95ff343503c5977ffc840f",
  ],
  [
    "今日が土曜",
    () => demo({}, "2026-09-12"),
    "55e70c0f9163cfc485cc584ed213eb84e9a92b43c96a8bd23ac067d507a38fd0",
  ],
];

describe("草の SVG の本文 (既知の答え)", () => {
  it.each(CASES)("%s", async (_, render, expected) => {
    expect(await sha256Hex(render())).toBe(expected);
  });
});
