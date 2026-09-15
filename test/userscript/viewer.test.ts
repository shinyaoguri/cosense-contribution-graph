import { describe, expect, it } from "vitest";
import { PH_ALL, phOf, publicIdOf } from "../../src/shared/ids.ts";
import { SIGN_IN_MENU_TITLE } from "../../src/userscript/auth.ts";
import type { SendStatus } from "../../src/userscript/sender.ts";
import { describeView, TOTAL_LABEL } from "../../src/userscript/viewer.ts";
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

describe("describeView", () => {
  it("**合算を先頭に、今のプロジェクトを次に、残りは状況の順に並べる**", async () => {
    const status = await enrolled([
      { name: "alpha", sent: true },
      { name: "beta", sent: false },
      { name: "gamma", sent: true },
    ]);

    const view = describeView(status, "beta");

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

    const view = describeView(status, "秘密のプロジェクト");

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
    const view = describeView(await enrolled([{ name: "alpha", sent: true }]), "not-installed");

    if (view.kind !== "graphs") throw new Error("graphs のはず");
    expect(view.projects.map((p) => p.label)).toEqual(["alpha"]);
  });

  it("記録したプロジェクトが無ければ合算だけ", async () => {
    const view = describeView(await enrolled([]), "alpha");

    expect(view.kind === "graphs" && view.projects).toEqual([]);
  });

  it.each([
    ["not-enrolled", `ページメニューの「${SIGN_IN_MENU_TITLE}」から登録してください。`],
    ["newer-key", "新しい版の cosense-grass が登録した鍵"],
    ["newer-sent", "新しい版の cosense-grass が送信の記録を書いている"],
    ["storage", "保存領域 (IndexedDB) を開けない"],
  ] as const)("**%s なら草を出さず、理由を書く**", (kind, text) => {
    const view = describeView({ kind }, "alpha");

    expect(view.kind).toBe("message");
    expect(view.kind === "message" && view.lines.join("\n")).toContain(text);
  });
});
