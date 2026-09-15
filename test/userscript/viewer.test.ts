import { describe, expect, it } from "vitest";
import { PH_ALL, phOf, publicIdOf } from "../../src/shared/ids.ts";
import type { SendStatus } from "../../src/userscript/sender.ts";
import { SETTINGS_LABEL, SIGN_IN_LABEL } from "../../src/userscript/settings.ts";
import { createStore } from "../../src/userscript/store.ts";
import {
  describeIntegrated,
  describeLocal,
  LOCAL_TOTAL_LABEL,
  localRangeStart,
  TOTAL_LABEL,
  tooltipOf,
} from "../../src/userscript/viewer.ts";
import { graphUrl } from "../../src/userscript/worker-origin.ts";

const UID = "AAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function enrolled(projects: readonly { name: string; sent: boolean }[]): Promise<SendStatus> {
  return {
    kind: "enrolled",
    kid: "0123456789abcdef",
    graphUrl: graphUrl(await publicIdOf(UID, PH_ALL)),
    projects: await Promise.all(
      projects.map(async ({ name, sent }) => ({
        name,
        graphUrl: graphUrl(await publicIdOf(UID, await phOf(UID, name))),
        sent,
      })),
    ),
    todaySends: 0,
    pendingDays: 0,
  };
}

describe("describeIntegrated", () => {
  it("**合算を先頭に、今のプロジェクトを次に、残りは状況の順に並べる**", async () => {
    const status = await enrolled([
      { name: "alpha", sent: true },
      { name: "beta", sent: false },
      { name: "gamma", sent: true },
    ]);

    const view = describeIntegrated(status, "beta");

    expect(view.kind).toBe("graphs");
    if (view.kind !== "graphs") return;
    expect(view.total).toEqual({
      label: TOTAL_LABEL,
      url: status.kind === "enrolled" && status.graphUrl,
      sent: true,
    });
    expect(view.projects.map((p) => [p.label, p.sent])).toEqual([
      ["beta (このプロジェクト)", false],
      ["alpha", true],
      ["gamma", true],
    ]);
  });

  it("**URL は状況の値そのもの** (32 桁の publicId で、プロジェクト名もクエリも含まない)", async () => {
    const status = await enrolled([{ name: "秘密のプロジェクト", sent: true }]);

    const view = describeIntegrated(status, "秘密のプロジェクト");

    if (view.kind !== "graphs") throw new Error("graphs のはず");
    for (const entry of [view.total, ...view.projects]) {
      expect(entry.url).toMatch(/^https:\/\/grass\.soui\.dev\/v1\/g\/[0-9a-f]{32}\.svg$/);
      expect(decodeURIComponent(entry.url)).not.toContain("秘密");
    }
    expect(view.projects[0]?.url).toBe(
      graphUrl(await publicIdOf(UID, await phOf(UID, "秘密のプロジェクト"))),
    );
  });

  it("**今のプロジェクトに記録が無ければ出さない** (未導入のプロジェクトで 404 の草を並べない)", async () => {
    const view = describeIntegrated(
      await enrolled([{ name: "alpha", sent: true }]),
      "not-installed",
    );

    if (view.kind !== "graphs") throw new Error("graphs のはず");
    expect(view.projects.map((p) => p.label)).toEqual(["alpha"]);
  });

  it("記録したプロジェクトが無ければ合算だけ", async () => {
    const view = describeIntegrated(await enrolled([]), "alpha");

    expect(view.kind === "graphs" && view.projects).toEqual([]);
  });

  it.each([
    [
      "not-enrolled",
      `このダイアログの下の「${SETTINGS_LABEL}」→「${SIGN_IN_LABEL}」から登録してください。`,
    ],
    ["newer-key", "新しい版の cosense-grass が登録した鍵"],
    ["newer-sent", "新しい版の cosense-grass が送信の記録を書いている"],
    ["storage", "保存領域 (IndexedDB) を開けない"],
  ] as const)("**%s なら草を出さず、理由を書く**", (kind, text) => {
    const view = describeIntegrated({ kind }, "alpha");

    expect(view.kind).toBe("message");
    expect(view.kind === "message" && view.lines.join("\n")).toContain(text);
  });
});

describe("describeLocal", () => {
  const TODAY = "2026-09-15";

  function records(
    activities: readonly { project: string; day: string; w?: number; r?: number }[],
  ) {
    const map = new Map<string, string>();
    const store = createStore(
      { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) },
      () => undefined,
    );
    for (const { project, day, w = 0, r = 0 } of activities) {
      for (let minute = 0; minute < w; minute++) {
        store.record({ kind: "write", project, day, minute });
      }
      for (let minute = 0; minute < r; minute++) {
        store.record({ kind: "read", project, day, minute: 600 + minute });
      }
    }
    return store.readRange(localRangeStart(TODAY), TODAY);
  }

  it("**合算と、表示範囲に記録のあるプロジェクトの草を作る。** 今のプロジェクトが先頭、残りは分数の多い順", () => {
    const days = records([
      { project: "few", day: TODAY, r: 3 },
      { project: "many", day: TODAY, w: 10 },
      { project: "current", day: "2026-09-14", r: 1 },
      { project: "tie-b", day: TODAY, r: 3 },
    ]);

    const view = describeLocal(days, TODAY, "current");

    expect(view.total.label).toBe(LOCAL_TOTAL_LABEL);
    expect(view.projects.map((p) => p.label)).toEqual([
      "current (このプロジェクト)",
      "many",
      "few",
      "tie-b",
    ]);
    expect(view.total.input.today).toBe(TODAY);
    // few と tie-b の読みは同じ分なので、合算では 1 回に数える
    expect(view.total.input.days.get(TODAY)).toEqual({ w: 10, r: 3 });
    expect(view.projects[1]?.input.days.get(TODAY)).toEqual({ w: 10, r: 0 });
    expect(view.projects[1]?.counts.get(TODAY)).toEqual({ w: 10, r: 0, pages: 0, created: 0 });
  });

  it("**プロジェクト別も合算の四分位と中心で塗る** (ADR-0007 決定 4)", () => {
    const days = records([
      { project: "a", day: TODAY, w: 30 },
      { project: "b", day: "2026-09-14", r: 5 },
    ]);

    const view = describeLocal(days, TODAY, "a");

    for (const graph of view.projects) {
      expect(graph.input.scale).toEqual(view.total.input.scale);
      expect(graph.input.center).toBe(view.total.input.center);
    }
  });

  it("**四分位の母集団は表示範囲より古い日も含む。** 表示する日には入れない", () => {
    // 表示範囲 (53 週) は 2025-09-16 から。371 日の範囲には入る
    const old = "2025-09-12";
    const withOld = records([
      { project: "a", day: TODAY, w: 5 },
      { project: "a", day: old, w: 100 },
    ]);
    const withoutOld = records([{ project: "a", day: TODAY, w: 5 }]);

    const view = describeLocal(withOld, TODAY, "a");

    expect(view.total.input.days.has(old)).toBe(false);
    expect(view.projects.map((p) => p.label)).toEqual(["a (このプロジェクト)"]);
    expect(view.total.input.scale).not.toEqual(
      describeLocal(withoutOld, TODAY, "a").total.input.scale,
    );
  });

  it("**計測開始 = 記録のある最も古い日。プロジェクト別も同じ日を使う** (Issue #80)", () => {
    const days = records([
      { project: "alpha", day: "2026-08-01", w: 1 },
      { project: "beta", day: TODAY, w: 1 },
    ]);

    const view = describeLocal(days, TODAY, "alpha");

    expect(view.total.input.startDay).toBe("2026-08-01");
    // beta は 9/15 が初めてでも、計測していなかったのは 8/1 より前だけ
    expect(view.projects.map((p) => p.input.startDay)).toEqual(["2026-08-01", "2026-08-01"]);
  });

  it("記録が 1 日も無ければ開始日は無い", () => {
    const view = describeLocal(records([]), TODAY, "alpha");

    expect(view.total.input.startDay).toBeUndefined();
  });

  it("表示範囲に記録の無いプロジェクトは並べない。記録が無ければ合算だけ", () => {
    const view = describeLocal(records([{ project: "old", day: "2025-09-12", w: 5 }]), TODAY, "x");

    expect(view.projects).toEqual([]);
    expect(describeLocal(new Map(), TODAY, "x").total.input.days.size).toBe(0);
  });
});

describe("tooltipOf", () => {
  it("design §9 の形。記録の無い日は「記録なし」", () => {
    expect(tooltipOf("2026-09-12", { w: 12, r: 38, pages: 7, created: 2 })).toBe(
      "2026-09-12 — 書き 12 分 / 読み 38 分 / 7 ページ編集 / 2 ページ新規作成",
    );
    expect(tooltipOf("2026-09-13", undefined)).toBe("2026-09-13 — 記録なし");
    expect(tooltipOf("2026-09-13", { w: 0, r: 0, pages: 0, created: 0 })).toBe(
      "2026-09-13 — 記録なし",
    );
  });
});
