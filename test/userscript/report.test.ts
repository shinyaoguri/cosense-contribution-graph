import { describe, expect, it } from "vitest";
import { bitmapOf } from "../../src/shared/bits.ts";
import {
  ALERT_RANGES,
  activityRanges,
  describeSensorReport,
  formatRange,
} from "../../src/userscript/report.ts";
import { createStore } from "../../src/userscript/store.ts";

const range = (minutes: number[]) => bitmapOf(minutes);

describe("activityRanges", () => {
  it("連続した分を 1 つの区間にまとめる。`end` は含まない", () => {
    expect(activityRanges(range([]), range([540, 541, 542, 600]))).toEqual([
      { start: 540, end: 543, kind: "r" },
      { start: 600, end: 601, kind: "r" },
    ]);
  });

  it("**同じ分に両方あれば書きに数える。** 書きが読みの区間を分ける", () => {
    expect(activityRanges(range([541]), range([540, 541, 542]))).toEqual([
      { start: 540, end: 541, kind: "r" },
      { start: 541, end: 542, kind: "w" },
      { start: 542, end: 543, kind: "r" },
    ]);
  });

  it("23:59 まで続く区間も閉じる。記録が無ければ空", () => {
    expect(activityRanges(range([1439]), range([]))).toEqual([
      { start: 1439, end: 1440, kind: "w" },
    ]);
    expect(activityRanges(range([]), range([]))).toEqual([]);
  });

  it("区間を時刻と分数で書く", () => {
    expect(formatRange({ start: 542, end: 556, kind: "r" })).toBe("9:02–9:16 読み 14 分");
    expect(formatRange({ start: 1439, end: 1440, kind: "w" })).toBe("23:59–24:00 書き 1 分");
  });
});

function memoryStore() {
  const map = new Map<string, string>();
  return createStore(
    { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) },
    () => undefined,
  );
}

describe("describeSensorReport", () => {
  const now = new Date(2026, 8, 14, 18, 0, 0);

  it("今日の合算とプロジェクト別、区間、直近 7 日を出す", () => {
    const store = memoryStore();
    store.record({
      kind: "write",
      project: "project-b",
      day: "2026-09-14",
      minute: 540,
      pageId: "p1",
    });
    store.record({ kind: "read", project: "project-a", day: "2026-09-14", minute: 540 });
    store.record({ kind: "read", project: "project-a", day: "2026-09-10", minute: 0 });

    const report = describeSensorReport({
      title: "草",
      now,
      project: "project-a",
      status: "counting",
      store,
    });

    const lines = report.alert.split("\n");
    expect(lines).toContain("このタブ: project-a を数えている");
    expect(lines).toContain("合算: 書き 1 分 / 読み 0 分 / 編集 1 ページ / 新規 0 ページ");
    // プロジェクト名の順
    expect(
      lines.indexOf("project-a: 書き 0 分 / 読み 1 分 / 編集 0 ページ / 新規 0 ページ"),
    ).toBeLessThan(
      lines.indexOf("project-b: 書き 1 分 / 読み 0 分 / 編集 1 ページ / 新規 0 ページ"),
    );
    expect(lines).toContain("9:00–9:01 書き 1 分");
    expect(lines).toContain("2026-09-08: 書き 0 分 / 読み 0 分");
    expect(lines).toContain("2026-09-10: 書き 0 分 / 読み 1 分");
    expect(lines).not.toContain("2026-09-07: 書き 0 分 / 読み 0 分");
  });

  it("記録が無ければ区間は「まだ無い」", () => {
    const report = describeSensorReport({
      title: "草",
      now,
      project: "project-a",
      status: "checking",
      store: memoryStore(),
    });

    expect(report.alert).toContain("今日の区間 (合算)\nまだ無い");
    expect(report.alert).toContain("import の 1 行があるか確かめている");
  });

  it(`**alert には新しい区間を ${ALERT_RANGES} 個まで出し、コンソールにはすべて出す**`, () => {
    const store = memoryStore();
    const count = ALERT_RANGES + 5;
    for (let i = 0; i < count; i++) {
      // 1 分おきにして区間を分ける
      store.record({ kind: "read", project: "project-a", day: "2026-09-14", minute: i * 2 });
    }

    const report = describeSensorReport({
      title: "草",
      now,
      project: "project-a",
      status: "counting",
      store,
    });

    expect(report.alert).toContain(`新しい ${ALERT_RANGES} 個。ほか 5 個はコンソール`);
    expect(report.alert).not.toContain("0:00–0:01 読み");
    expect(report.alert).toContain(
      `${formatRange({ start: (count - 1) * 2, end: (count - 1) * 2 + 1, kind: "r" })}`,
    );
    expect(report.console).toContain("0:00–0:01 読み 1 分");
    expect(report.console.match(/読み 1 分/g)).toHaveLength(count);
  });
});
