/**
 * カードの図の SVG の本文を、既知の答え (SHA-256) で固定する (草の `svg-golden.test.ts` と同じ考え方)。
 *
 * 本文が変わると ETag も変わり、共有 SVG のキャッシュが入れ替わる (ADR-0015 決定 2)。
 * **描画を意図して変える PR は、ここの答えを更新し、見た目の証跡 (Gyazo) を PR に貼る。**
 * デモは `DEMO_TODAY` に固定した日付と固定のアイコンで描くので、いつ走らせても同じ本文になる。
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/shared/hash.ts";

const DEMO_URL = "https://example.com/v1/g/demo/card.svg";

const CASES: readonly (readonly [string, string, string])[] = [
  ["デモ (日本語・ライト)", "", "137b7ddbe2abf51739d3063070c89b44cdb2bfa9fa4741630baea67c81afa0e3"],
  [
    "デモ (日本語・ダーク)",
    "?theme=dark",
    "958c134a65064fb919bd299141185375fe7a6fed6a73bad87f8136a09a9b5b04",
  ],
  [
    "デモ (英語・ライト)",
    "?lang=en",
    "a249bbaf2b29f73b4917988a3d7daa51749acd2926beb5037022ef7c3ead5416",
  ],
  [
    "デモ (英語・ダーク)",
    "?lang=en&theme=dark",
    "95c4cdc7a4ed9a4643e8cab6807564f9fa0778f46f7056fae52f95ef98cd7da1",
  ],
  ["半年 × 1 日", "?cell=day", "7810e8dcd137bb9e83cb477ddf823bd56f2b6615703f1e78eddd5bb5db49dc53"],
  [
    "1 年 × 3 分割",
    "?span=year",
    "a45b990c4f115d2379b9f0bb2b86c6873c7cc5787b8f17aa18e1eb9d87b758d4",
  ],
  [
    "1 年 × 1 日",
    "?span=year&cell=day",
    "219ae70993e6863c16d17a7d268f010ee5381c83cbb259443f1150514eed66a5",
  ],
  [
    "1 年 × 1 日 (ダーク・英語)",
    "?span=year&cell=day&theme=dark&lang=en",
    "9a227687740d60a5b195f366307a7abb2750c995ce8897251ceb198c4216f849",
  ],
  [
    "書いた分だけ (mode=write)",
    "?mode=write",
    "7c800ee6d08675c9a10194098e8778d2bf2a98328ebc9f08a897b3c573c46d93",
  ],
  [
    "過去の年 (記録の無い期間)",
    "?year=2025&cell=day",
    "be6647315ccdcf743e455b26e7f7224b03f988417aaaff125dd3765611cbea0a",
  ],
];

describe("カードの図の SVG の本文 (ゴールデン)", () => {
  it.each(CASES)("%s", async (_name, query, expected) => {
    const res = await SELF.fetch(`${DEMO_URL}${query}`);
    expect(await sha256Hex(await res.text())).toBe(expected);
  });
});
