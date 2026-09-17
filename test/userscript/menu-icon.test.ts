import { describe, expect, it } from "vitest";
import { describeMenuState, type MenuState, menuIcon } from "../../src/userscript/menu-icon.ts";
import type { SendStatus } from "../../src/userscript/sender.ts";

const enrolled: SendStatus = {
  kind: "enrolled",
  kid: "0123456789abcdef",
  graphUrl: "https://grass.soui.dev/v1/g/total.svg",
  totalSent: true,
  projects: [],
  todaySends: 0,
  pendingPastDays: 0,
  todayPending: false,
};

describe("状態の判定", () => {
  it("**数えていないことが最優先** (送れる状態でも、このプロジェクトでは記録が増えない)", () => {
    expect(describeMenuState("not-installed", enrolled)).toBe("not-installed");
    expect(describeMenuState("not-installed", { kind: "not-enrolled" })).toBe("not-installed");
  });

  it("数えていて登録済みなら送っている", () => {
    expect(describeMenuState("counting", enrolled)).toBe("synced");
  });

  it("数えていて未登録なら、このブラウザにしか記録が無い", () => {
    expect(describeMenuState("counting", { kind: "not-enrolled" })).toBe("local-only");
  });

  it("導入判定の最中は決めない", () => {
    expect(describeMenuState("checking", enrolled)).toBe("unknown");
  });

  it("**送信の異常系は `local-only` と言い切らない** (登録済みなのに読めないだけのことがある)", () => {
    for (const kind of ["newer-key", "newer-sent", "storage"] as const) {
      expect(describeMenuState("counting", { kind })).toBe("unknown");
    }
  });
});

describe("アイコン", () => {
  const states: MenuState[] = ["unknown", "not-installed", "local-only", "synced"];

  it("**data: URI の SVG を返す** (Cosense の CSP は `img-src * data:`。外へ取りに行かない)", () => {
    for (const state of states) {
      expect(menuIcon(state)).toMatch(/^data:image\/svg\+xml,/);
      expect(decodeURIComponent(menuIcon(state))).toContain(
        '<svg xmlns="http://www.w3.org/2000/svg"',
      );
    }
  });

  it("**3 つの状態が別の絵になる** (アイコンだけで見分けられる)", () => {
    const icons = new Set(
      ["not-installed", "local-only", "synced"].map((s) => menuIcon(s as MenuState)),
    );

    expect(icons.size).toBe(3);
  });

  it("**判定の最中は `local-only` と同じ絵** (決まるまでちらつかせない)", () => {
    expect(menuIcon("unknown")).toBe(menuIcon("local-only"));
  });

  it("**数えていないときは塗らず、点線の枠だけ** (design §9 の「点線は計測開始前」と同じ使い方)", () => {
    const svg = decodeURIComponent(menuIcon("not-installed"));

    expect(svg).toContain("stroke-dasharray");
    expect(svg).not.toContain('fill="#');
  });

  it("送っているときは塗る", () => {
    const svg = decodeURIComponent(menuIcon("synced"));

    expect(svg).toContain('fill="#');
    expect(svg).not.toContain("stroke-dasharray");
  });
});
