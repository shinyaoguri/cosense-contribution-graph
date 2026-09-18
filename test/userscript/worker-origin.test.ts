import { describe, expect, it } from "vitest";
import { graphUrl, WORKER_ORIGIN } from "../../src/userscript/worker-origin.ts";

describe("graphUrl", () => {
  it("独自ドメインの共有 SVG の URL", () => {
    expect(WORKER_ORIGIN).toBe("https://grass.soui.dev");
    expect(graphUrl("0123456789abcdef0123456789abcdef")).toBe(
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg",
    );
  });

  it("**プロジェクト名を渡すと `?l=` を付ける** (貼った先でも名前が出る。Issue #119)", () => {
    expect(graphUrl("0123456789abcdef0123456789abcdef", "villagepump")).toBe(
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg?l=villagepump",
    );
  });

  it("**形が取り決めの外なら付けない** (付けても Worker が描かないので、URL を汚さない)", () => {
    for (const name of ["-a", "a_b", "日本語", "a b", ""]) {
      expect(graphUrl("0123456789abcdef0123456789abcdef", name)).toBe(
        "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg",
      );
    }
  });
});
