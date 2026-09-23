import { describe, expect, it } from "vitest";
import { parseUser } from "../../src/worker/params.ts";

/** ユーザー名 (`?u=`。Issue #134)。扱いはプロジェクト名 (`?l=`) と同じで、サーバは保存しない */
describe("parseUser", () => {
  it("**`?u=` の名前を返す**", () => {
    expect(parseUser(new URLSearchParams("u=example-user"))).toBe("example-user");
  });

  it("渡さなければ undefined", () => {
    expect(parseUser(new URLSearchParams(""))).toBeUndefined();
    expect(parseUser(new URLSearchParams("l=villagepump"))).toBeUndefined();
  });

  it("**形の違う名前は落とす** (エラーにはしない。画像として読まれるので、描かないだけにする)", () => {
    for (const raw of ["-a", "a-", "a_b", "a b", "日本語", "a".repeat(65), ""]) {
      expect(parseUser(new URLSearchParams({ u: raw }))).toBeUndefined();
    }
  });

  it("**SVG を壊そうとする値は形で落ちる** (`escapeXml` に頼らない)", () => {
    for (const raw of ['"><script>alert(1)</script>', "</text><a>", "a&b", "a'b"]) {
      expect(parseUser(new URLSearchParams({ u: raw }))).toBeUndefined();
    }
  });
});
