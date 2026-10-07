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
  ["デモ (日本語・ライト)", "", "c12913127579fdb3e3761b6f26c49d5e28f0337f84f1e49138fee14ef198af72"],
  [
    "デモ (日本語・ダーク)",
    "?theme=dark",
    "a7e0161cea386941605e02a35558f99e61974d22cd501762aeb8faff522291eb",
  ],
  [
    "デモ (英語・ライト)",
    "?lang=en",
    "cad3c65141be636a0766a902c7fb806424df46b96254f90acefb67e1458cad51",
  ],
  [
    "デモ (英語・ダーク)",
    "?lang=en&theme=dark",
    "562bf452dc4500ae216d12edf7ce75d0884b3bcc787b0b1e69a19becfbfc927b",
  ],
];

describe("カードの図の SVG の本文 (ゴールデン)", () => {
  it.each(CASES)("%s", async (_name, query, expected) => {
    const res = await SELF.fetch(`${DEMO_URL}${query}`);
    expect(await sha256Hex(await res.text())).toBe(expected);
  });
});
