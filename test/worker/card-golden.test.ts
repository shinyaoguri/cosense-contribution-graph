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
  ["デモ (日本語・ライト)", "", "ba543a4081612c76b8845c0465c4b6490336c5d385abfe3d36216ddcde05f0ae"],
  [
    "デモ (日本語・ダーク)",
    "?theme=dark",
    "f90788d3c65cdd8e8e1c4ec6c326477cdee8894a700c8a59d71d9503d801e054",
  ],
  [
    "デモ (英語・ライト)",
    "?lang=en",
    "f99b858167648f9f4ed2a7d4f561f5d9679a98830f491a38254a519841f4a1af",
  ],
  [
    "デモ (英語・ダーク)",
    "?lang=en&theme=dark",
    "a1d2241a992dadffe97b06bbc4ea724033b19fa252f97295a7dae2dc11e0af42",
  ],
];

describe("カードの図の SVG の本文 (ゴールデン)", () => {
  it.each(CASES)("%s", async (_name, query, expected) => {
    const res = await SELF.fetch(`${DEMO_URL}${query}`);
    expect(await sha256Hex(await res.text())).toBe(expected);
  });
});
