import { describe, expect, it } from "vitest";
import { dataKeyOf, PH_ALL, phOf, publicIdOf } from "../../src/shared/ids.ts";
import { MAX_TODAY_SENDS } from "../../src/userscript/outbox.ts";
import type { SendStatus } from "../../src/userscript/sender.ts";
import { SETTINGS_LABEL, SIGN_IN_LABEL } from "../../src/userscript/settings.ts";
import {
  AUTO_SEND_NOTE,
  describeIntegrated,
  describeSync,
  SEND_NOW_LABEL,
  TOTAL_LABEL,
} from "../../src/userscript/viewer.ts";
import { dataUrl, graphUrl, overviewUrl } from "../../src/userscript/worker-origin.ts";

const UID = "AAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** 2026-09-15 12:00 (ローカル) */
const NOW = new Date(2026, 8, 15, 12, 0);

async function enrolled(
  projects: readonly { name: string; sent: boolean }[],
  totalSent = true,
): Promise<SendStatus> {
  return {
    kind: "enrolled",
    kid: "0123456789abcdef",
    graphUrl: graphUrl(await publicIdOf(UID, PH_ALL)),
    overviewUrl: overviewUrl(await publicIdOf(UID, PH_ALL)),
    dataUrl: dataUrl(await publicIdOf(UID, PH_ALL), await dataKeyOf(UID, PH_ALL)),
    totalSent,
    projects: await Promise.all(
      projects.map(async ({ name, sent }) => ({
        name,
        graphUrl: graphUrl(await publicIdOf(UID, await phOf(UID, name))),
        overviewUrl: overviewUrl(await publicIdOf(UID, await phOf(UID, name))),
        dataUrl: dataUrl(
          await publicIdOf(UID, await phOf(UID, name)),
          await dataKeyOf(UID, await phOf(UID, name)),
        ),
        sent,
      })),
    ),
    todaySends: 0,
    pendingPastDays: 0,
    todayPending: false,
  };
}

describe("describeSync", () => {
  type Enrolled = Extract<SendStatus, { kind: "enrolled" }>;

  const sync = async (over: Partial<Enrolled> = {}) => {
    const base = await enrolled([]);
    if (base.kind !== "enrolled") throw new Error();
    return describeSync({ ...base, ...over }, NOW);
  };

  /** ローカル時刻の時分 */
  const at = (hour: number, minute: number, dayOffset = 0) =>
    new Date(2026, 8, 15 + dayOffset, hour, minute).getTime();

  it("**未送信が無ければ「送信済み」で、押せない**", async () => {
    const view = await sync();

    expect(view.lines[0]).toBe("このブラウザの記録は送信済みです。");
    expect(view.lines[1]).toBe("今日の分も送信済みです。");
    // 自動で送っていることを必ず添える (押す必要が普段ないと分かる)
    expect(view.lines.at(-1)).toBe(AUTO_SEND_NOTE);
    expect(view.canSend).toBe(false);
  });

  it("**前日以前の未送信は日数を出して押せる**", async () => {
    const view = await sync({ pendingPastDays: 3 });

    expect(view.lines[0]).toBe("まだ送れていない記録が 3 日分あります。");
    expect(view.canSend).toBe(true);
  });

  it("**今日の未送信は警告にしない** (タブを離れれば自動で送るので、開くたびに出ては困る)", async () => {
    const view = await sync({ todayPending: true });

    expect(view.lines[0]).toBe("このブラウザの記録は送信済みです。");
    expect(view.lines[1]).toBe("今日の分はまだ送っていません (タブを離れると自動で送ります)。");
    expect(view.canSend).toBe(true);
  });

  it("**当日の上限に達していて、今日しか残っていなければ押せない**", async () => {
    const view = await sync({ todayPending: true, todaySends: MAX_TODAY_SENDS });

    expect(view.lines[1]).toContain(`上限 (1 日 ${MAX_TODAY_SENDS} 回) に達した`);
    expect(view.canSend).toBe(false);
  });

  it("**上限に達していても、前日以前が残っていれば押せる** (送信はそれを送る)", async () => {
    const view = await sync({
      todayPending: true,
      todaySends: MAX_TODAY_SENDS,
      pendingPastDays: 1,
    });

    expect(view.canSend).toBe(true);
  });

  it("**`last` は結果で言い分ける** (結果を問わず書かれるので、失敗を「送った」と言わない)", async () => {
    const sent = await sync({
      last: { at: at(9, 5), trigger: "load", outcome: "written", requests: 1, entries: 2 },
    });
    expect(sent.lines).toContain("最後に送ったのは 09:05 (ページを開いたとき)。");

    const tried = await sync({
      last: { at: at(9, 5), trigger: "hidden", outcome: "timeout", requests: 1, entries: 2 },
    });
    expect(tried.lines).toContain("最後に試したのは 09:05 ですが、送れませんでした。");
  });

  it("**今日でなければ日付も出す** (「09:05」だけでは昨日か今日か分からない)", async () => {
    const view = await sync({
      last: { at: at(9, 5, -1), trigger: "load", outcome: "written", requests: 1, entries: 2 },
    });

    expect(view.lines).toContain("最後に送ったのは 9/14 09:05 (ページを開いたとき)。");
  });

  it("**抑制中は、自動を止めていることと手動は試すことを書く**", async () => {
    const view = await sync({ pendingPastDays: 1, backoffUntil: at(15, 30) });

    expect(view.lines).toContain(
      `続けて送信に失敗したので、自動の送信を 15:30 まで止めています。「${SEND_NOW_LABEL}」はすぐ試します。`,
    );
    expect(view.canSend).toBe(true);
  });
});

describe("describeIntegrated", () => {
  it("**合算も送れたかで `sent` を決める** (登録しただけでは共有 SVG が無い。Issue #100)", async () => {
    const view = describeIntegrated(
      await enrolled([{ name: "alpha", sent: false }], false),
      "",
      NOW,
    );

    expect(view.kind).toBe("graphs");
    if (view.kind !== "graphs") return;
    // false なら画像を読まず、押されてから読む (404 のリクエストを出さない)
    expect(view.total.sent).toBe(false);
  });

  it("**合算を先頭に、今のプロジェクトを次に、残りは状況の順に並べる**", async () => {
    const status = await enrolled([
      { name: "alpha", sent: true },
      { name: "beta", sent: false },
      { name: "gamma", sent: true },
    ]);

    const view = describeIntegrated(status, "beta", NOW);

    expect(view.kind).toBe("graphs");
    if (view.kind !== "graphs") return;
    expect(view.total).toEqual({
      label: TOTAL_LABEL,
      url: status.kind === "enrolled" && status.graphUrl,
      overviewUrl: status.kind === "enrolled" && status.overviewUrl,
      dataUrl: status.kind === "enrolled" && status.dataUrl,
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

    const view = describeIntegrated(status, "秘密のプロジェクト", NOW);

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
      NOW,
    );

    if (view.kind !== "graphs") throw new Error("graphs のはず");
    expect(view.projects.map((p) => p.label)).toEqual(["alpha"]);
  });

  it("記録したプロジェクトが無ければ合算だけ", async () => {
    const view = describeIntegrated(await enrolled([]), "alpha", NOW);

    expect(view.kind === "graphs" && view.projects).toEqual([]);
  });

  // 草を描くのは Worker だけなので、未登録のブラウザではこの文言が唯一の中身になる (ADR-0019)
  it("**未登録なら草は 1 枚も出ない。** すでに数えていることを伝える", () => {
    const view = describeIntegrated({ kind: "not-enrolled" }, "alpha", NOW);

    expect(view.kind === "message" && view.lines.join("\n")).toContain("活動はすでに数えていて");
  });

  it.each([
    [
      "not-enrolled",
      `このダイアログの下の「${SETTINGS_LABEL}」→「${SIGN_IN_LABEL}」から登録できます。`,
    ],
    ["newer-key", "新しい版の cosense-grass が登録した鍵"],
    ["newer-sent", "新しい版の cosense-grass が送信の記録を書いている"],
    ["storage", "保存領域 (IndexedDB) を開けない"],
  ] as const)("**%s なら草を出さず、理由を書く**", (kind, text) => {
    const view = describeIntegrated({ kind }, "alpha", NOW);

    expect(view.kind).toBe("message");
    expect(view.kind === "message" && view.lines.join("\n")).toContain(text);
  });
});
