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
  ["デモ (日本語・ライト)", "", "a3a061dd0239b8ca76c21cccdc58acf64496b7d39e3540b39227c058c3577099"],
  [
    "デモ (日本語・ダーク)",
    "?theme=dark",
    "42e7a1739d4f6e1211da9e4ffde524d20a0fa2ad5e50f990e35510c42610cb0f",
  ],
  [
    "デモ (英語・ライト)",
    "?lang=en",
    "441024147980cbd34220c4c63b921abdaa4e43167bf4c7f6b344becc118f3f52",
  ],
  [
    "デモ (英語・ダーク)",
    "?lang=en&theme=dark",
    "ee967050206f892e03194b6bda4d6c7c54b16acd745ed2f8e86bb60f0ea23852",
  ],
  ["半年 × 1 日", "?cell=day", "8fa2b94fae0030fdcf4463ddf8fd166560e0a92482b7af87ce663ca3af240e62"],
  [
    "1 年 × 3 分割",
    "?span=year",
    "16f49ba432ac6c8206ef0589ba0c28eb4a0138920a05ff57528945a81cba035e",
  ],
  [
    "1 年 × 1 日",
    "?span=year&cell=day",
    "e1349e75051c5e283c0539a4816d5594396a7c6a464d319eab3c6bfe3226b519",
  ],
  [
    "1 年 × 1 日 (ダーク・英語)",
    "?span=year&cell=day&theme=dark&lang=en",
    "2ff89c02717e2b65b2c747606432b924063a36738856f78f850405a0fd5fa81f",
  ],
  [
    "書いた分だけ (mode=write)",
    "?mode=write",
    "577f8d6a7b4fc87fff4cc1f5794a681699580e48bf3b065987bffd7bbb4c481a",
  ],
  [
    "過去の年 (記録の無い期間)",
    "?year=2025&cell=day",
    "484cc6365ceac7542d10be8fd0319c44c6732081e6a32255ca3e4fac7746799a",
  ],
];

describe("カードの図の SVG の本文 (ゴールデン)", () => {
  it.each(CASES)("%s", async (_name, query, expected) => {
    const res = await SELF.fetch(`${DEMO_URL}${query}`);
    expect(await sha256Hex(await res.text())).toBe(expected);
  });
});
