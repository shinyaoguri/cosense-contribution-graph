import { describe, expect, it } from "vitest";
import { decodeBase64url } from "../../src/shared/base64url.ts";
import { fromEpochDay, toEpochDay } from "../../src/shared/graph.ts";
import {
  type Activity,
  BITS_DAYS,
  BITS_KEY,
  createStore,
  DAILY_DAYS,
  DAILY_KEY,
  type DayView,
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
    expect(store.fold(TODAY)).toBe("blocked");
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

describe("fold", () => {
  it(`**今日から ${BITS_DAYS - 1} 日前までのビットマップは残し、それより古い日を集計値に畳む**`, () => {
    const { storage, store } = setup();
    const kept = daysBefore(BITS_DAYS - 1);
    const folded = daysBefore(BITS_DAYS);
    store.record(read("project-a", 600, kept));
    store.record(write("project-a", 600, PAGE_A, folded));
    store.record(read("project-a", 601, folded));
    store.record(write("project-b", 600, PAGE_B, folded));

    expect(store.fold(TODAY)).toBe("written");

    const bits = JSON.parse(storage.map.get(BITS_KEY) ?? "");
    expect(Object.keys(bits.days)).toEqual([kept]);
    const daily = JSON.parse(storage.map.get(DAILY_KEY) ?? "");
    expect(daily.days[folded]).toEqual({
      // 合算は OR から数える。2 つのプロジェクトで同じ 10:00 に書いたので w は 1
      "*": { w: 1, r: 1, pages: 2, created: 0 },
      "project-a": { w: 1, r: 1, pages: 1, created: 0 },
      "project-b": { w: 1, r: 0, pages: 1, created: 0 },
    });

    // 畳んだ日も読める (ビットマップは無い)
    const day = store.readDay(folded);
    expect(day.total).toEqual({ counts: { w: 1, r: 1, pages: 2, created: 0 } });
    expect(day.projects.get("project-b")?.counts.w).toBe(1);
  });

  it("畳むものが無ければ書かない", () => {
    const { storage, store } = setup();
    store.record(read("project-a", 0));
    const writes = storage.state.writes;

    expect(store.fold(TODAY)).toBe("unchanged");
    expect(storage.state.writes).toBe(writes);
  });

  it(`${DAILY_DAYS} 日より古い集計値は消す`, () => {
    const { storage, store } = setup();
    const counts = { w: 1, r: 0, pages: 0, created: 0 };
    storage.map.set(
      DAILY_KEY,
      JSON.stringify({
        v: STORE_VERSION,
        days: {
          [daysBefore(DAILY_DAYS - 1)]: { "*": counts },
          [daysBefore(DAILY_DAYS)]: { "*": counts },
        },
      }),
    );

    expect(store.fold(TODAY)).toBe("written");
    const daily = JSON.parse(storage.map.get(DAILY_KEY) ?? "");
    expect(Object.keys(daily.days)).toEqual([daysBefore(DAILY_DAYS - 1)]);
  });

  it("**既に畳んだ集計値とは w と合計の max でまとめる** (前回ビットマップを消せなかったとき二重にしない)", () => {
    const { storage, store } = setup();
    const day = daysBefore(BITS_DAYS);
    storage.map.set(
      DAILY_KEY,
      JSON.stringify({
        v: STORE_VERSION,
        days: { [day]: { "*": { w: 5, r: 0, pages: 3, created: 0 } } },
      }),
    );
    for (const minute of [0, 1, 2]) {
      store.record(write("project-a", minute, undefined, day));
    }
    for (const minute of [3, 4, 5, 6]) {
      store.record(read("project-a", minute, day));
    }

    store.fold(TODAY);
    const daily = JSON.parse(storage.map.get(DAILY_KEY) ?? "");
    // w = max(5, 3)、合計 = max(5, 7)
    expect(daily.days[day]["*"]).toEqual({ w: 5, r: 2, pages: 3, created: 0 });
  });

  it("**集計値を書けなければ、ビットマップを消さない**", () => {
    const { storage, store } = setup();
    const day = daysBefore(BITS_DAYS);
    store.record(read("project-a", 0, day));
    // ビットマップは書けるが、集計値だけ書けない
    storage.state.failing.add(DAILY_KEY);

    expect(store.fold(TODAY)).toBe("failed");
    const bits = JSON.parse(storage.map.get(BITS_KEY) ?? "");
    expect(Object.keys(bits.days)).toEqual([day]);
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
});

describe("readRange", () => {
  const counts = (w: number, r: number, pages = 0, created = 0) => ({ w, r, pages, created });

  /**
   * 範囲の内外に、ビットマップの日・ビットマップが空の日・両方にある日・集計値だけの日 (`*` あり・なし・空) を混ぜる。
   * `getItem` を数える。
   */
  function mixed() {
    const t = setup();
    t.store.record(read("a", 1, daysBefore(1)));
    t.store.record(write("b", 2, PAGE_A, daysBefore(1)));
    t.store.record(read("a", 3, daysBefore(2)));
    const bits = JSON.parse(t.storage.map.get(BITS_KEY) ?? "{}");
    bits.days[daysBefore(3)] = {};
    t.storage.map.set(BITS_KEY, JSON.stringify(bits));
    t.storage.map.set(
      DAILY_KEY,
      JSON.stringify({
        v: STORE_VERSION,
        days: {
          [daysBefore(2)]: { "*": counts(9, 9), a: counts(9, 9) },
          [daysBefore(3)]: { "*": counts(5, 1, 2, 1), a: counts(5, 1, 2, 1) },
          [daysBefore(40)]: { a: counts(4, 0) },
          [daysBefore(41)]: {},
          [daysBefore(DAILY_DAYS)]: { "*": counts(1, 1) },
        },
      }),
    );
    const gets = new Map<string, number>();
    const getItem = t.storage.getItem;
    t.storage.getItem = (key: string) => {
      gets.set(key, (gets.get(key) ?? 0) + 1);
      return getItem(key);
    };
    const store = createStore(t.storage, () => undefined);
    return { ...t, store, gets };
  }

  const summary = (range: ReadonlyMap<string, DayView>) =>
    Object.fromEntries(
      [...range].map(([day, view]) => [
        day,
        {
          total: view.total.counts,
          bits: view.total.bits !== undefined,
          projects: Object.fromEntries([...view.projects].map(([name, row]) => [name, row.counts])),
        },
      ]),
    );

  it("**ビットマップのある日はそれから、無い日は集計値から読む。** 記録の無い日と範囲外は入れない", () => {
    const t = mixed();

    const range = t.store.readRange(daysBefore(DAILY_DAYS - 1), TODAY);

    expect(summary(range)).toEqual({
      [daysBefore(1)]: {
        total: counts(1, 1, 1),
        bits: true,
        projects: { a: counts(0, 1), b: counts(1, 0, 1) },
      },
      // 集計値にもあるが、ビットマップが正
      [daysBefore(2)]: { total: counts(0, 1), bits: true, projects: { a: counts(0, 1) } },
      // ビットマップが空なので集計値から
      [daysBefore(3)]: {
        total: counts(5, 1, 2, 1),
        bits: false,
        projects: { a: counts(5, 1, 2, 1) },
      },
      // `*` の無い集計値は合算を 0 にする (プロジェクト行を足さない)
      [daysBefore(40)]: { total: counts(0, 0), bits: false, projects: { a: counts(4, 0) } },
    });
  });

  it("**localStorage はキーごとに 1 回だけ読む**", () => {
    const t = mixed();

    t.store.readRange(daysBefore(DAILY_DAYS - 1), TODAY);

    expect(Object.fromEntries(t.gets)).toEqual({ [BITS_KEY]: 1, [DAILY_KEY]: 1 });
  });

  it("**ビットマップで埋まる範囲なら集計値を読まない**", () => {
    const t = mixed();

    t.store.readRange(daysBefore(2), daysBefore(1));

    expect(Object.fromEntries(t.gets)).toEqual({ [BITS_KEY]: 1 });
  });

  it("範囲の両端を含む", () => {
    const t = mixed();

    expect([...t.store.readRange(daysBefore(3), daysBefore(2)).keys()].sort()).toEqual([
      daysBefore(3),
      daysBefore(2),
    ]);
  });

  it.each([
    ["ビットマップが知らない版", BITS_KEY, [daysBefore(3), daysBefore(2), daysBefore(40)]],
    ["集計値が知らない版", DAILY_KEY, [daysBefore(2), daysBefore(1)]],
  ] as const)("**%s なら、読める方だけから読む**", (_, key, expected) => {
    const t = mixed();
    const value = JSON.parse(t.storage.map.get(key) ?? "{}");
    t.storage.map.set(key, JSON.stringify({ ...value, v: STORE_VERSION + 1 }));

    const range = t.store.readRange(daysBefore(DAILY_DAYS - 1), TODAY);

    expect([...range.keys()].sort()).toEqual([...expected].sort());
  });

  it("両方とも知らない版なら空。ビットマップが JSON として読めなければ集計値から読む", () => {
    const t = mixed();
    const newer = (key: string) =>
      t.storage.map.set(
        key,
        JSON.stringify({ ...JSON.parse(t.storage.map.get(key) ?? "{}"), v: STORE_VERSION + 1 }),
      );
    newer(BITS_KEY);
    newer(DAILY_KEY);
    expect(t.store.readRange(daysBefore(DAILY_DAYS - 1), TODAY).size).toBe(0);

    const u = mixed();
    u.storage.map.set(BITS_KEY, "{");
    expect([...u.store.readRange(daysBefore(DAILY_DAYS - 1), TODAY).keys()].sort()).toEqual(
      [daysBefore(40), daysBefore(3), daysBefore(2)].sort(),
    );
  });

  it("逆の範囲と実在しない日は例外", () => {
    const { store } = setup();
    expect(() => store.readRange(TODAY, daysBefore(1))).toThrow(RangeError);
    expect(() => store.readRange("2026-02-30", TODAY)).toThrow(RangeError);
  });
});
