import { describe, expect, it } from "vitest";
import { localDay, localMinute } from "../../src/userscript/time.ts";

// Date はローカル時刻の成分で作る。jsdom は実行するマシンのタイムゾーンで動き、CI は UTC なので、
// どちらでも同じ結果になる形で確かめる。

describe("ローカル時刻の日と分", () => {
  it("日付はローカル時刻で決める", () => {
    expect(localDay(new Date(2026, 0, 2, 0, 0, 0))).toBe("2026-01-02");
    expect(localDay(new Date(2026, 11, 31, 23, 59, 59))).toBe("2026-12-31");
  });

  it("分はローカル時刻の 0:00 からの分。0:00 が 0、23:59 が 1439", () => {
    expect(localMinute(new Date(2026, 8, 14, 0, 0, 59))).toBe(0);
    expect(localMinute(new Date(2026, 8, 14, 9, 30, 0))).toBe(570);
    expect(localMinute(new Date(2026, 8, 14, 23, 59, 59))).toBe(1439);
  });
});
