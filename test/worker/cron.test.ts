import { createScheduledController, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bitmapOf } from "../../src/shared/bits.ts";
import { PH_ALL } from "../../src/shared/ids.ts";
import worker from "../../src/worker/index.ts";

// D1 はファイル内で共有されるので、Cron のテストは受け口のテストと分けて置く

const NOW = Date.parse("2026-09-14T03:17:00Z");
const UID = "cron-test-uid";

async function insertDay(day: string) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO daybits (uid, ph, day, wbits, rbits) VALUES (?, ?, ?, ?, ?)").bind(
      UID,
      PH_ALL,
      day,
      bitmapOf([1]),
      bitmapOf([]),
    ),
    env.DB.prepare("INSERT INTO daily (uid, ph, day, w, r) VALUES (?, ?, ?, 1, 0)").bind(
      UID,
      PH_ALL,
      day,
    ),
  ]);
}

async function days(table: "daybits" | "daily"): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT day FROM ${table} WHERE uid = ? ORDER BY day`)
    .bind(UID)
    .all<{ day: string }>();
  return results.map((row) => row.day);
}

describe("Cron", () => {
  it("**91 日前のビットマップを消し、90 日前は残す。daily は消さない**", async () => {
    // 2026-09-14 の 90 日前が 2026-06-16
    await insertDay("2026-06-15");
    await insertDay("2026-06-16");
    await insertDay("2026-09-13");

    const controller = createScheduledController({ scheduledTime: NOW, cron: "17 3 * * *" });
    await worker.scheduled(controller, env);

    expect(await days("daybits")).toEqual(["2026-06-16", "2026-09-13"]);
    expect(await days("daily")).toEqual(["2026-06-15", "2026-06-16", "2026-09-13"]);
  });
});
