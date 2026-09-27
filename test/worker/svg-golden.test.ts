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
    "9af2545fee5a08614702b8c93fb44c7cfad92044f8f4cb8975ae61c355d7e8c1",
  ],
  [
    "デモ (ダーク)",
    () => demo({ theme: "dark" }),
    "a347750c8f85f2b189f1aa0207cf37331b266d820f6b3bed3898b1b9b48cd1ec",
  ],
  [
    "mode=write",
    () => demo({ mode: "write" }),
    "9573711b179f333eae419950c9a1ee96acb27409bc32bf8a837d2c143212f99a",
  ],
  [
    "weeks=10",
    () => demo({ weeks: 10 }),
    "872e9344512a9843867584fdfac25c5f344a2c5981bb68e25f1886846812c250",
  ],
  [
    "weeks=1 (凡例の方が広い)",
    () => demo({ weeks: 1 }),
    "edbf617571f9d884070432d392193c847d6e7d9394d88344002eaa261499e16a",
  ],
  ["母集団が空", empty, "74917bbdd8def24622ba6b98814e450cf7b4aae8d16e935953471bb1f2ae84cb"],
  [
    "計測開始の印 (Issue #80)",
    () => demo({}, DEMO_TODAY, "2026-06-01"),
    "02933c6795d9fab123540a2653ceaec50103be0fdff97bd07cc09b92777b1913",
  ],
  [
    "プロジェクト名とリンク (Issue #119)",
    () => demo({}, DEMO_TODAY, undefined, "villagepump"),
    "2989ef534671b946826c8cf4f0b72edf39cab2436ad34d65080534209571e9d0",
  ],
  [
    "プロジェクト名とユーザー名 (Issue #134、2026-09-24 に太字・濃い色へ)",
    () => demo({}, DEMO_TODAY, undefined, "villagepump", { user: "example-user" }),
    "4a6573e70d43d88c33db1371729af7ba3d91e6a3b778b91b6ae3060d0dc6e357",
  ],
  [
    "合算の印とユーザー名 (2026-09-24)",
    () => demo({}, DEMO_TODAY, undefined, undefined, { user: "example-user", total: true }),
    "def934380981946912d7253715f6bcd82d0fbd006aa1fcc47283649563d548b9",
  ],
  [
    "合算の印 (ダーク)",
    () => demo({ theme: "dark" }, DEMO_TODAY, undefined, undefined, { total: true }),
    "7ae10697c1e345f7f424e3266d1d7f08c886519edc42aa877896288ee50c0a43",
  ],
  [
    "今日が日曜",
    () => demo({}, "2026-09-13"),
    "fca459c3816368aca2ae3cfc5bf70aae47caa2fbbd28a1ad78a3e607a7f25f69",
  ],
  [
    "今日が土曜",
    () => demo({}, "2026-09-12"),
    "bd7cdb5b40fda48f79c36795c97093dd043e643c0d42c9c3360200057dd440f8",
  ],
];

describe("草の SVG の本文 (既知の答え)", () => {
  it.each(CASES)("%s", async (_, render, expected) => {
    expect(await sha256Hex(render())).toBe(expected);
  });
});
