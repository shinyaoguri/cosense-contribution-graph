import { describe, expect, it } from "vitest";
import {
  ACCEPT_PAST_DAYS,
  acceptsDay,
  DAYBITS_RETENTION_DAYS,
  daybitsCutoff,
} from "../../src/worker/days.ts";

const at = (iso: string) => Date.parse(iso);

describe("記録を受け付ける日", () => {
  it("**受け付ける窓より保持日数が長い** (受け付けた日のビットマップが Cron で消えていないこと)", () => {
    // 窓の最も古い日は UTC の今日の 31 日前になりうる
    expect(ACCEPT_PAST_DAYS + 1).toBeLessThan(DAYBITS_RETENTION_DAYS);
  });

  it("**UTC+14 の地域の今日までは受け付け、その翌日は未来として拒否する**", () => {
    // 10:00 UTC は UTC+14 で翌日の 0:00
    const now = at("2026-09-14T10:00:00Z");
    expect(acceptsDay("2026-09-15", now)).toBe(true);
    expect(acceptsDay("2026-09-16", now)).toBe(false);

    // 09:59 UTC ではまだ翌日になっている地域が無い
    expect(acceptsDay("2026-09-15", at("2026-09-14T09:59:59Z"))).toBe(false);
  });

  it("**UTC−12 の地域の今日から 30 日前までを受け付ける**", () => {
    // 03:00 UTC は UTC−12 で前日の 15:00。その 30 日前が 2026-08-14
    const now = at("2026-09-14T03:00:00Z");
    expect(acceptsDay("2026-08-14", now)).toBe(true);
    expect(acceptsDay("2026-08-13", now)).toBe(false);

    // 12:00 UTC を過ぎると UTC−12 も同じ日になり、窓の端が 1 日進む
    expect(acceptsDay("2026-08-14", at("2026-09-14T12:00:00Z"))).toBe(false);
    expect(acceptsDay("2026-08-15", at("2026-09-14T12:00:00Z"))).toBe(true);
  });

  it("月と年をまたいでも数える", () => {
    expect(acceptsDay("2026-01-02", at("2026-01-01T10:00:00Z"))).toBe(true);
    expect(acceptsDay("2025-12-02", at("2026-01-01T12:00:00Z"))).toBe(true);
    expect(acceptsDay("2025-12-01", at("2026-01-01T12:00:00Z"))).toBe(false);
  });
});

describe("Cron が消すビットマップ", () => {
  it("UTC の今日から 90 日前の日を境にする (その日は残す)", () => {
    expect(daybitsCutoff(at("2026-09-14T03:17:00Z"))).toBe("2026-06-16");
  });
});
