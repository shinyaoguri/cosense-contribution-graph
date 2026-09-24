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
  extra: { readonly user?: string; readonly total?: boolean } = {},
): string {
  const { days, population } = demoData();
  return renderGraph({
    today,
    days,
    scale: buildScale(population.map((d) => d.w + d.r)),
    center: centerOf(population),
    startDay,
    label,
    ...extra,
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
    "772a7b2108179039ff8cb5e91cd957b1579a7f17c907f7ccbed985d8274e699a",
  ],
  [
    "デモ (ダーク)",
    () => demo({ theme: "dark" }),
    "82f0331dd8f9114b3f15e57a4d656cb8c9e994361f5fd3b18c2b2e0b872866c0",
  ],
  [
    "mode=write",
    () => demo({ mode: "write" }),
    "b5b3d8b349bdfa61053b6e7c46ff25829ef3fd0f2bfabb4c97950b07f25cb406",
  ],
  [
    "weeks=10",
    () => demo({ weeks: 10 }),
    "fd136d650bf1caf33a194fb4fab938874deaa66b280d6ae345ee26e529795c1d",
  ],
  [
    "weeks=1 (凡例の方が広い)",
    () => demo({ weeks: 1 }),
    "1b57fecb4251186fbf79e9ebeb6da3f6eb0aaa221c06abbcc19e3a65adfd2d74",
  ],
  [
    "palette=blue-yellow (ダーク)",
    () => demo({ palette: "blue-yellow", theme: "dark" }),
    "c5e913baf108c59bb5115c2a90fc39655091562db5f0b96af187139ec0132974",
  ],
  ["母集団が空", empty, "263e4181ce57aad511d3054a67f67e0f120caecaf86d0599763f6d9bdf9d3cad"],
  [
    "計測開始の印 (Issue #80)",
    () => demo({}, DEMO_TODAY, "2026-06-01"),
    "51e69316cd9b66f34f3de3cd42b5b14bb60a42481afa056aaf9844bcb4e4a860",
  ],
  [
    "プロジェクト名とリンク (Issue #119)",
    () => demo({}, DEMO_TODAY, undefined, "villagepump"),
    "565ac213a481ab344ddfef350daddddcd629a0758cef995fac9a0441bdf0a5f6",
  ],
  [
    "プロジェクト名とユーザー名 (Issue #134、2026-09-24 に太字・濃い色へ)",
    () => demo({}, DEMO_TODAY, undefined, "villagepump", { user: "example-user" }),
    "55ae0c637f86dfb2c3da5062b9c8966d78bcb571450491266f4d74803890a96a",
  ],
  [
    "合算の印とユーザー名 (2026-09-24)",
    () => demo({}, DEMO_TODAY, undefined, undefined, { user: "example-user", total: true }),
    "c05f06090e9fa49ba27b35eae8b63b94fda07f49ad59a6acdda3d3a47aa51dfd",
  ],
  [
    "合算の印 (ダーク)",
    () => demo({ theme: "dark" }, DEMO_TODAY, undefined, undefined, { total: true }),
    "279c0adb05d23830690c932a04f4e9725321634c84b4786a6d5d09bd121a04b6",
  ],
  [
    "今日が日曜",
    () => demo({}, "2026-09-13"),
    "f0f68a8accc341032119dfab48404ac653487f93b4af34f87472bef77499e8d6",
  ],
  [
    "今日が土曜",
    () => demo({}, "2026-09-12"),
    "47bdaf5ecfc5c16cd6010118351c6415e7e2dc9f16c4da7fe2dc7bb9379a18b4",
  ],
];

describe("草の SVG の本文 (既知の答え)", () => {
  it.each(CASES)("%s", async (_, render, expected) => {
    expect(await sha256Hex(render())).toBe(expected);
  });
});
