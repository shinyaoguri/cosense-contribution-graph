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
  ["デモ (日本語・ライト)", "", "fb1ff344fffa9057e8614b2f90527f43f00804a2622282056b770d8b1516e7f7"],
  [
    "デモ (日本語・ダーク)",
    "?theme=dark",
    "35dfd0ddf2e91eee200985bb5a41d37a21ae080b3ab15cf128fe4a20d91e4168",
  ],
  [
    "デモ (英語・ライト)",
    "?lang=en",
    "27d5149928989fb22aae423fa9501c8e58ee9d8543df1dac3fcac2a5c259cf3d",
  ],
  [
    "デモ (英語・ダーク)",
    "?lang=en&theme=dark",
    "e2a410ad4d3d3edf77c8f4acab51b4c8e96ffe4ad76794540e929a98bccf612f",
  ],
  ["半年 × 1 日", "?cell=day", "0e7ec25f13ae690133faf90fe43ca378c7d9d86ff42078fc3888c439ddde0cf7"],
  [
    "1 年 × 3 分割",
    "?span=year",
    "d97f36e1c2f67345fe80800c39618ab15139d8fc6f514971cb5bee8ca48ba694",
  ],
  [
    "1 年 × 1 日",
    "?span=year&cell=day",
    "28f0251986e810d600450da0a89a42748872ca485a1581aa670b8b2b5123f981",
  ],
  [
    "1 年 × 1 日 (ダーク・英語)",
    "?span=year&cell=day&theme=dark&lang=en",
    "1fefce624421048ae7adecb37ee40dc5cd1005cef6d6b09a37b353f5961fa5fb",
  ],
  [
    "書いた分だけ (mode=write)",
    "?mode=write",
    "fa4c3b6bec383d3a0b684f958c2258bcd078a9f21c0d44f087415b1ce7d8b7c3",
  ],
  [
    "過去の年 (記録の無い期間)",
    "?year=2025&cell=day",
    "3730c68e707e4222eb59601d33379e9440d2b565cec9a983b4790e2f604115c6",
  ],
];

describe("カードの図の SVG の本文 (ゴールデン)", () => {
  it.each(CASES)("%s", async (_name, query, expected) => {
    const res = await SELF.fetch(`${DEMO_URL}${query}`);
    expect(await sha256Hex(await res.text())).toBe(expected);
  });
});
