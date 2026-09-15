import { describe, expect, it } from "vitest";
import { decodeBase64url } from "../../src/shared/base64url.ts";
import { fromEpochDay, toEpochDay } from "../../src/shared/graph.ts";
import {
  type Activity,
  BITS_DAYS,
  BITS_KEY,
  createStore,
  LEGACY_DAILY_KEY,
  STORE_VERSION,
} from "../../src/userscript/store.ts";

const TODAY = "2026-09-14";
const PAGE_A = "0123456789abcdef01234567";
const PAGE_B = "fedcba9876543210fedcba98";

/** Map で置き換えた localStorage。書き込みの回数を数え、キーごとに例外を投げさせられる。 */
function memoryStorage() {
  const map = new Map<string, string>();
  const state = { writes: 0, failing: new Set<string>() };
  return {
    map,
    state,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (state.failing.has(key)) {
        throw new DOMException("quota", "QuotaExceededError");
      }
      state.writes++;
      map.set(key, value);
    },
    removeItem: (key: string) => {
      if (state.failing.has(key)) {
        throw new DOMException("quota", "QuotaExceededError");
      }
      map.delete(key);
    },
  };
}

function setup() {
  const storage = memoryStorage();
  const warnings: string[] = [];
  const store = createStore(storage, (message) => warnings.push(message));
  return { storage, warnings, store };
}

const read = (project: string, minute: number, day = TODAY): Activity => ({
  kind: "read",
  project,
  day,
  minute,
});

const write = (project: string, minute: number, pageId?: string, day = TODAY): Activity => ({
  kind: "write",
  project,
  day,
  minute,
  pageId,
});

const daysBefore = (n: number) => fromEpochDay(toEpochDay(TODAY) - n);

describe("record", () => {
  it("立てた分がその行と合算に入る。**同じ分をもう一度立てても書かない**", () => {
    const { storage, store } = setup();

    expect(store.record(read("project-a", 570))).toBe("written");
    expect(store.record(read("project-a", 570))).toBe("unchanged");
    expect(storage.state.writes).toBe(1);

    const day = store.readDay(TODAY);
    expect(day.projects.get("project-a")?.counts).toEqual({ w: 0, r: 1, pages: 0, created: 0 });
    expect(day.total.counts).toEqual({ w: 0, r: 1, pages: 0, created: 0 });
  });

  it("**2 つのプロジェクトで同じ分に活動したとき、合算の w は 2 ではなく 1** (二重計上しない)", () => {
    const { store } = setup();
    store.record(write("project-a", 600));
    store.record(write("project-b", 600));
    store.record(write("project-b", 601));

    const day = store.readDay(TODAY);
    expect(day.projects.get("project-a")?.counts.w).toBe(1);
    expect(day.projects.get("project-b")?.counts.w).toBe(2);
    expect(day.total.counts.w).toBe(2);
  });

  it("同じ分の読みと書きは書きに数える (`r & ~w`)", () => {
    const { store } = setup();
    store.record(read("project-a", 600));
    store.record(write("project-a", 600));
    store.record(read("project-a", 601));

    expect(store.readDay(TODAY).projects.get("project-a")?.counts).toMatchObject({ w: 1, r: 1 });
  });

  it("**別のプロジェクトで書きだった分は、合算でも書きに数える**", () => {
    const { store } = setup();
    store.record(read("project-a", 600));
    store.record(write("project-b", 600));

    expect(store.readDay(TODAY).total.counts).toMatchObject({ w: 1, r: 0 });
  });

  it("編集したページは ID で 1 回だけ数える。合算は各行の ID の和集合", () => {
    const { storage, store } = setup();
    expect(store.record(write("project-a", 600, PAGE_A))).toBe("written");
    // 同じ分でも、新しいページなら書く
    expect(store.record(write("project-a", 600, PAGE_B))).toBe("written");
    expect(store.record(write("project-a", 601, PAGE_A))).toBe("written");
    expect(store.record(write("project-a", 601, PAGE_A))).toBe("unchanged");
    store.record(write("project-b", 602, PAGE_A));

    const day = store.readDay(TODAY);
    expect(day.projects.get("project-a")?.counts.pages).toBe(2);
    expect(day.projects.get("project-b")?.counts.pages).toBe(1);
    expect(day.total.counts.pages).toBe(2);
    expect(storage.state.writes).toBe(4);
  });

  it("新規作成したページも ID で 1 回だけ数える", () => {
    const { store } = setup();
    const created: Activity = { kind: "created", project: "project-a", day: TODAY, pageId: PAGE_A };
    expect(store.record(created)).toBe("written");
    expect(store.record(created)).toBe("unchanged");

    expect(store.readDay(TODAY).total.counts).toEqual({ w: 0, r: 0, pages: 0, created: 1 });
  });

  it("**書くたびに読み直す。** 別のタブが間に書いた bit を消さない", () => {
    const storage = memoryStorage();
    const tabA = createStore(storage, () => undefined);
    const tabB = createStore(storage, () => undefined);

    tabA.record(read("project-a", 600));
    tabB.record(read("project-b", 601));
    tabA.record(read("project-a", 602));

    const day = tabB.readDay(TODAY);
    expect(day.projects.get("project-a")?.counts.r).toBe(2);
    expect(day.projects.get("project-b")?.counts.r).toBe(1);
    expect(day.total.counts.r).toBe(3);
  });

  it("日ごとに分けて持つ", () => {
    const { store } = setup();
    store.record(read("project-a", 1439, "2026-09-13"));
    store.record(read("project-a", 0, TODAY));

    expect(store.readDay("2026-09-13").total.counts.r).toBe(1);
    expect(store.readDay(TODAY).total.counts.r).toBe(1);
  });

  it("保存する形。版と、日 → プロジェクト名 → 180 バイトの base64url とページ ID", () => {
    const { storage, store } = setup();
    store.record(write("project-a", 0, PAGE_A));

    const saved = JSON.parse(storage.map.get(BITS_KEY) ?? "");
    expect(saved.v).toBe(STORE_VERSION);
    const row = saved.days[TODAY]["project-a"];
    expect(row).toEqual({
      w: expect.any(String),
      r: expect.any(String),
      pages: [PAGE_A],
      created: [],
    });
    // 0:00 はバイト 0 の最上位 (design §4)
    expect(decodeBase64url(row.w)?.[0]).toBe(0x80);
    expect(row.r).toHaveLength(240);
    // 合算の行は持たない
    expect(Object.keys(saved.days[TODAY])).toEqual(["project-a"]);
  });

  it("不正な入力は例外にする (`*` は合算の予約値、実在しない日、範囲外の分)", () => {
    const { store } = setup();
    expect(() => store.record(read("*", 0))).toThrow(RangeError);
    expect(() => store.record(read("", 0))).toThrow(RangeError);
    expect(() => store.record(read("project-a", 0, "2026-02-30"))).toThrow(RangeError);
    expect(() => store.record(read("project-a", 1440))).toThrow(RangeError);
    expect(() => store.record(write("project-a", 0, ""))).toThrow(RangeError);
  });
});

describe("壊れた記録と、書けないとき", () => {
  it("**知らない版の記録があれば書かない。** 警告は 1 回だけ", () => {
    const { storage, warnings, store } = setup();
    const newer = JSON.stringify({ v: STORE_VERSION + 1, days: {} });
    storage.map.set(BITS_KEY, newer);

    expect(store.record(read("project-a", 0))).toBe("blocked");
    expect(store.record(read("project-a", 1))).toBe("blocked");
    expect(store.sweep(TODAY)).toBe("blocked");
    expect(storage.map.get(BITS_KEY)).toBe(newer);
    expect(warnings).toHaveLength(1);
  });

  it("JSON として読めなければ、空から書き直して警告する", () => {
    const { storage, warnings, store } = setup();
    storage.map.set(BITS_KEY, "{");

    expect(store.record(read("project-a", 0))).toBe("written");
    expect(store.readDay(TODAY).total.counts.r).toBe(1);
    expect(warnings).toHaveLength(1);
  });

  it("壊れたビットマップは 0 として読み、形の違う行と日は無視する", () => {
    const { storage, store } = setup();
    storage.map.set(
      BITS_KEY,
      JSON.stringify({
        v: STORE_VERSION,
        days: {
          [TODAY]: { "project-a": { w: "!!", r: 3, pages: [PAGE_A, 7], created: "x" }, "": {} },
          "2026-02-30": { "project-a": {} },
        },
      }),
    );

    const day = store.readDay(TODAY);
    expect([...day.projects.keys()]).toEqual(["project-a"]);
    expect(day.total.counts).toEqual({ w: 0, r: 0, pages: 1, created: 0 });
  });

  it("**書き込みが例外になっても外へ投げない** (容量超過)。警告は 1 回だけ", () => {
    const { storage, warnings, store } = setup();
    storage.state.failing.add(BITS_KEY);

    expect(store.record(read("project-a", 0))).toBe("failed");
    expect(store.record(read("project-a", 1))).toBe("failed");
    expect(warnings).toHaveLength(1);
  });
});

describe("sweep", () => {
  it(`**今日から ${BITS_DAYS - 1} 日前までのビットマップを残し、それより古い日は消す**`, () => {
    const { storage, store } = setup();
    const kept = daysBefore(BITS_DAYS - 1);
    const dropped = daysBefore(BITS_DAYS);
    store.record(read("project-a", 600, kept));
    store.record(write("project-a", 600, PAGE_A, dropped));

    expect(store.sweep(TODAY)).toBe("written");

    const bits = JSON.parse(storage.map.get(BITS_KEY) ?? "");
    expect(Object.keys(bits.days)).toEqual([kept]);
    // **消した日はもう読めない。** 送れない日の記録を持ち続けない (ADR-0019)
    expect(store.readDay(dropped).total.counts).toEqual({ w: 0, r: 0, pages: 0, created: 0 });
  });

  it("消すものが無ければ書かない", () => {
    const { storage, store } = setup();
    store.record(read("project-a", 0));
    const writes = storage.state.writes;

    expect(store.sweep(TODAY)).toBe("unchanged");
    expect(storage.state.writes).toBe(writes);
  });

  it("**1.0.0 までの日次集計を消す** (ADR-0019)", () => {
    const { storage, store } = setup();
    storage.map.set(LEGACY_DAILY_KEY, JSON.stringify({ v: STORE_VERSION, days: {} }));

    expect(store.sweep(TODAY)).toBe("written");
    expect(storage.map.has(LEGACY_DAILY_KEY)).toBe(false);
  });

  it("壊れた日次集計も消すが、**知らない版が書いたものは触らない**", () => {
    const { storage, store } = setup();
    storage.map.set(LEGACY_DAILY_KEY, "{");

    expect(store.sweep(TODAY)).toBe("written");
    expect(storage.map.has(LEGACY_DAILY_KEY)).toBe(false);

    const newer = JSON.stringify({ v: STORE_VERSION + 1, days: {} });
    storage.map.set(LEGACY_DAILY_KEY, newer);

    expect(store.sweep(TODAY)).toBe("unchanged");
    expect(storage.map.get(LEGACY_DAILY_KEY)).toBe(newer);
  });

  it("**日次集計を消せなくても、古いビットマップは消す**", () => {
    const { storage, warnings, store } = setup();
    const dropped = daysBefore(BITS_DAYS);
    store.record(read("project-a", 0, dropped));
    storage.map.set(LEGACY_DAILY_KEY, JSON.stringify({ v: STORE_VERSION, days: {} }));
    storage.state.failing.add(LEGACY_DAILY_KEY);

    expect(store.sweep(TODAY)).toBe("written");
    const bits = JSON.parse(storage.map.get(BITS_KEY) ?? "");
    expect(Object.keys(bits.days)).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

describe("readDay", () => {
  it("記録の無い日は 0", () => {
    const { store } = setup();
    const day = store.readDay(TODAY);
    expect(day.total.counts).toEqual({ w: 0, r: 0, pages: 0, created: 0 });
    expect(day.projects.size).toBe(0);
  });

  it("ビットマップを持つ日は、合算とプロジェクト別のビットマップも返す", () => {
    const { store } = setup();
    store.record(read("project-a", 0));
    store.record(write("project-b", 0));

    const day = store.readDay(TODAY);
    expect(day.total.bits?.w[0]).toBe(0x80);
    expect(day.total.bits?.r[0]).toBe(0x80);
    expect(day.projects.get("project-a")?.bits?.w[0]).toBe(0);
  });

  // 書き込みは "blocked" で断るが、**読みは黙って空を返す** (草を出せないだけで、壊れたとは言わない)
  it("知らない版の記録は空を返す", () => {
    const { storage, store } = setup();
    storage.map.set(BITS_KEY, JSON.stringify({ v: STORE_VERSION + 1, days: {} }));

    expect(store.readDay(TODAY).total.counts).toEqual({ w: 0, r: 0, pages: 0, created: 0 });
  });

  it("JSON として読めなければ空を返す", () => {
    const { storage, store } = setup();
    storage.map.set(BITS_KEY, "{");

    expect(store.readDay(TODAY).total.counts).toEqual({ w: 0, r: 0, pages: 0, created: 0 });
  });

  it("実在しない日は例外", () => {
    const { store } = setup();

    expect(() => store.readDay("2026-02-30")).toThrow(RangeError);
  });
});
