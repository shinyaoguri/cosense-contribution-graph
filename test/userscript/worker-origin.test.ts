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
    expect(graphUrl("0123456789abcdef0123456789abcdef", { project: "villagepump" })).toBe(
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg?l=villagepump",
    );
  });

  it("**ユーザー名を渡すと `u=` を付ける。プロジェクト名があれば `&` で続ける** (Issue #134)", () => {
    expect(graphUrl("0123456789abcdef0123456789abcdef", { user: "example-user" })).toBe(
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg?u=example-user",
    );
    expect(
      graphUrl("0123456789abcdef0123456789abcdef", {
        project: "villagepump",
        user: "example-user",
      }),
    ).toBe(
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg?l=villagepump&u=example-user",
    );
  });

  it("**片方だけ形が外れていれば、そちらだけ落とす**", () => {
    expect(graphUrl("0123456789abcdef0123456789abcdef", { project: "a_b", user: "ok" })).toBe(
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg?u=ok",
    );
    expect(graphUrl("0123456789abcdef0123456789abcdef", { project: "ok", user: "<x>" })).toBe(
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg?l=ok",
    );
  });

  it("**形が取り決めの外なら付けない** (付けても Worker が描かないので、URL を汚さない)", () => {
    for (const name of ["-a", "a_b", "日本語", "a b", ""]) {
      expect(graphUrl("0123456789abcdef0123456789abcdef", { project: name, user: name })).toBe(
        "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg",
      );
    }
  });
});
