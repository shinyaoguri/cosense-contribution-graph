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
  ["デモ (日本語・ライト)", "", "59ee5c5e2604d749ede78390bb969b3e17c998f8d411f1e43564bbd6001673aa"],
  [
    "デモ (日本語・ダーク)",
    "?theme=dark",
    "a4f13b9842ef1494a45d086742b5a825137e747812a4e9d08c3b9ea208198e03",
  ],
  [
    "デモ (英語・ライト)",
    "?lang=en",
    "30f73267b24ea26a85fd16e6b41dd613093667f18e5b4f2067b8872a3fc963f1",
  ],
  [
    "デモ (英語・ダーク)",
    "?lang=en&theme=dark",
    "bed47dcb826f0f0b7ef9e3bb6663c003a7bbb86e97ef5efe739a7c900ab999e0",
  ],
  ["半年 × 1 日", "?cell=day", "0e7ec25f13ae690133faf90fe43ca378c7d9d86ff42078fc3888c439ddde0cf7"],
  [
    "1 年 × 3 分割",
    "?span=year",
    "3295203ce0e7ea220116dde77eeb01491bc11c0ae09cec7a130a7c8bfe662f07",
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
    "38d55f3bfce1eb191d19f1c128f2050a7d16c2a7f2c2c176cf9b787edc30b1c3",
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
