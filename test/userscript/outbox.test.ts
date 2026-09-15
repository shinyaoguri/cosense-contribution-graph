import { describe, expect, it } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import {
  buildIngestUrl,
  type Entry,
  MAX_ENTRIES,
  parseIngestQuery,
} from "../../src/shared/beacon.ts";
import { bitmapOf, popcount } from "../../src/shared/bits.ts";
import { PH_ALL, phOf } from "../../src/shared/ids.ts";
import {
  candidateDays,
  chunk,
  collectEntries,
  countTodaySend,
  EMPTY_SENT,
  entryDigest,
  MAX_URL_LENGTH,
  readSent,
  rememberSent,
  SENT_KEY,
  writeSent,
} from "../../src/userscript/outbox.ts";
import { BITS_KEY, createStore } from "../../src/userscript/store.ts";

const UID = encodeBase64url(new Uint8Array(20).fill(5));
const OTHER_UID = encodeBase64url(new Uint8Array(20).fill(6));
const TODAY = "2026-09-15";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

function storeWith(activities: Parameters<ReturnType<typeof createStore>["record"]>[0][]) {
  const storage = memoryStorage();
  const store = createStore(storage, () => undefined);
  for (const activity of activities) {
    store.record(activity);
  }
  return { store, storage };
}

describe("candidateDays", () => {
  it("**今日の前日から 29 日前まで**、新しい順。今日は指定したときだけ先頭に", () => {
    const past = candidateDays(TODAY, false);
    expect(past).toHaveLength(29);
    expect(past[0]).toBe("2026-09-14");
    expect(past.at(-1)).toBe("2026-08-17");
    expect(past).not.toContain("2026-08-16");
    expect(candidateDays(TODAY, true)[0]).toBe(TODAY);
  });
});

describe("collectEntries", () => {
  it("**プロジェクト名は ph にして送り、合算 * は各行の OR** (同じ分の活動を 2 分に数えない)", async () => {
    const { store } = storeWith([
      { kind: "write", project: "project-a", day: TODAY, minute: 600 },
      { kind: "write", project: "project-b", day: TODAY, minute: 600 },
      { kind: "read", project: "project-b", day: TODAY, minute: 601 },
    ]);
    const entries = await collectEntries(store, UID, [TODAY]);

    expect(entries.map((e) => e.ph).sort()).toEqual(
      [await phOf(UID, "project-a"), await phOf(UID, "project-b"), PH_ALL].sort(),
    );
    const total = entries.find((e) => e.ph === PH_ALL);
    expect(total && popcount(total.wbits)).toBe(1);
    expect(total && popcount(total.rbits)).toBe(1);
    expect(JSON.stringify(entries)).not.toContain("project-a");
  });

  it("**URL にプロジェクト名が出ない**", async () => {
    const { store } = storeWith([
      { kind: "read", project: "secret-project", day: TODAY, minute: 1 },
    ]);
    const entries = await collectEntries(store, UID, [TODAY]);
    const url = await buildIngestUrl(
      "https://grass.soui.dev",
      { uid: UID, kid: "0123456789abcdef", time: 1, entries },
      async () => new Uint8Array(64),
    );
    expect(url).not.toContain("secret-project");
  });

  it("活動の無い日は何も出さない", async () => {
    const { store } = storeWith([{ kind: "read", project: "p", day: TODAY, minute: 1 }]);
    expect(await collectEntries(store, UID, ["2026-09-14"])).toEqual([]);
  });

  it("知らない版の記録からは何も出さない", async () => {
    const { store, storage } = storeWith([{ kind: "read", project: "p", day: TODAY, minute: 1 }]);
    storage.setItem(BITS_KEY, JSON.stringify({ v: 2, days: {} }));
    expect(await collectEntries(store, UID, [TODAY])).toEqual([]);
  });

  it("ページの編集だけの行も送る (ビットマップと同じ行に数が入る)", async () => {
    const { store } = storeWith([
      { kind: "write", project: "p", day: TODAY, minute: 5, pageId: "page-1" },
    ]);
    const entries = await collectEntries(store, UID, [TODAY]);
    expect(entries.every((e) => e.pages === 1)).toBe(true);
  });
});

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    ph: PH_ALL,
    day: TODAY,
    wbits: bitmapOf([1]),
    rbits: bitmapOf([2]),
    pages: 0,
    created: 0,
    ...overrides,
  };
}

describe("entryDigest", () => {
  it("**1 bit 変われば変わる**", async () => {
    expect(await entryDigest(UID, entry())).not.toBe(
      await entryDigest(UID, entry({ wbits: bitmapOf([1, 3]) })),
    );
  });

  it("**uid が違えば変わる** (別のアカウントに入り直したら送り直す)", async () => {
    expect(await entryDigest(UID, entry())).not.toBe(await entryDigest(OTHER_UID, entry()));
  });

  it("同じ中身なら同じ", async () => {
    expect(await entryDigest(UID, entry())).toBe(await entryDigest(UID, entry()));
  });
});

describe("chunk と URL の長さ", () => {
  it(`${MAX_ENTRIES} 件ずつに分ける`, () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    expect(chunk(items).map((c) => c.length)).toEqual([14, 14, 2]);
    expect(chunk([])).toEqual([]);
  });

  it(`**最悪の ${MAX_ENTRIES} 件でも URL は ${MAX_URL_LENGTH} 文字以下**`, async () => {
    const full = bitmapOf(Array.from({ length: 1440 }, (_, i) => i));
    const days = candidateDays(TODAY, true).slice(0, MAX_ENTRIES);
    const entries = days.map((day) =>
      entry({
        ph: "fedcba9876543210",
        day,
        wbits: full,
        rbits: full,
        pages: 99_999,
        created: 99_999,
      }),
    );
    const url = await buildIngestUrl(
      "https://grass.soui.dev",
      { uid: UID, kid: "0123456789abcdef", time: 1_789_404_127, entries },
      async () => new Uint8Array(64).fill(255),
    );
    expect(url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
    expect(parseIngestQuery(new URL(url).searchParams).ok).toBe(true);
  });
});

describe("cosense-grass:sent", () => {
  it("書いて読むと戻る。29 日より古い日は刈る", () => {
    const storage = memoryStorage();
    const record = {
      ...EMPTY_SENT,
      days: {
        [TODAY]: { e: ["a"], n: 2 },
        "2026-08-17": { e: ["b"], n: 0 },
        "2026-08-16": { e: ["c"], n: 0 },
      },
    };
    expect(writeSent(storage, record, TODAY)).toBe(true);
    const read = readSent(storage);
    expect(read !== "newer" && Object.keys(read.days).sort()).toEqual(["2026-08-17", TODAY]);
  });

  it("壊れた JSON と無い値は空として読む", () => {
    const storage = memoryStorage();
    expect(readSent(storage)).toEqual(EMPTY_SENT);
    storage.setItem(SENT_KEY, "{");
    expect(readSent(storage)).toEqual(EMPTY_SENT);
  });

  it("**知らない版なら newer** (送らない)", () => {
    const storage = memoryStorage();
    storage.setItem(SENT_KEY, JSON.stringify({ v: 2, days: {} }));
    expect(readSent(storage)).toBe("newer");
  });

  it("書けなければ false", () => {
    expect(
      writeSent(
        {
          setItem: () => {
            throw new Error("quota");
          },
        },
        EMPTY_SENT,
        TODAY,
      ),
    ).toBe(false);
  });

  it("**rememberSent は今のダイジェストに含まれるものだけを残す** (古いダイジェストを溜めない)", () => {
    let record = rememberSent(EMPTY_SENT, TODAY, ["old-a"], ["old-a", "b"]);
    expect(record.days[TODAY]?.e).toEqual(["old-a"]);
    record = rememberSent(record, TODAY, ["new-a"], ["new-a", "b"]);
    expect(record.days[TODAY]?.e).toEqual(["new-a"]);
  });

  it("countTodaySend は回数だけを増やす", () => {
    const record = countTodaySend(rememberSent(EMPTY_SENT, TODAY, ["a"], ["a"]), TODAY);
    expect(record.days[TODAY]).toEqual({ e: ["a"], n: 1 });
  });
});
