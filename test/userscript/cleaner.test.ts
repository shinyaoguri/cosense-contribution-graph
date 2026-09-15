import { describe, expect, it } from "vitest";
import { CLEARED_KEYS, createCleaner } from "../../src/userscript/cleaner.ts";
import { SENT_KEY } from "../../src/userscript/outbox.ts";
import { SETTINGS_KEY } from "../../src/userscript/settings-store.ts";
import { BITS_KEY, DAILY_KEY } from "../../src/userscript/store.ts";

function setup(options: { fails?: boolean } = {}) {
  // 記録と設定が入っている状態から始める
  const stored = new Map<string, string>(
    [BITS_KEY, DAILY_KEY, SENT_KEY, SETTINGS_KEY].map((key) => [key, "{}"]),
  );
  const removed: string[] = [];
  const cleaner = createCleaner({
    storage: {
      removeItem: (key) => {
        if (options.fails) {
          throw new Error("removeItem");
        }
        removed.push(key);
        stored.delete(key);
      },
    },
  });
  return { cleaner, stored, removed };
}

describe("このブラウザの記録を消す", () => {
  it("**記録の 3 つのキーを消す**", () => {
    const t = setup();

    expect(t.cleaner.clearLocalRecords()).toBe("cleared");

    expect(t.removed).toEqual([...CLEARED_KEYS]);
    expect(CLEARED_KEYS).toEqual([BITS_KEY, DAILY_KEY, SENT_KEY]);
  });

  it("**設定は残す** (read 計上の on/off は記録ではなく好み)", () => {
    const t = setup();

    t.cleaner.clearLocalRecords();

    expect(t.stored.has(SETTINGS_KEY)).toBe(true);
    expect(t.removed).not.toContain(SETTINGS_KEY);
  });

  it("消せなければ failed", () => {
    const t = setup({ fails: true });

    expect(t.cleaner.clearLocalRecords()).toBe("failed");
  });
});
