import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseUser } from "../../src/worker/params.ts";

function fetchDemo(query = "") {
  return SELF.fetch(`https://example.com/v1/g/demo.svg${query}`);
}

function size(svg: string): { width: string | undefined; height: string | undefined } {
  const root = /^<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
  return {
    width: /\bwidth="([^"]*)"/.exec(root)?.[1],
    height: /\bheight="([^"]*)"/.exec(root)?.[1],
  };
}

/** ユーザー名 (`?u=`。Issue #134・#195)。プロジェクト名 (`?l=`) と同じくサーバは保存しないが、形はずっと広い */
describe("parseUser", () => {
  it("**`?u=` の名前を返す**", () => {
    expect(parseUser(new URLSearchParams("u=example-user"))).toBe("example-user");
  });

  it("渡さなければ undefined", () => {
    expect(parseUser(new URLSearchParams(""))).toBeUndefined();
    expect(parseUser(new URLSearchParams("l=villagepump"))).toBeUndefined();
  });

  it("**漢字・空白・記号・絵文字の名前も返す** (Issue #195)", () => {
    for (const raw of ["山田太郎", "山田 太郎", "a_b", "👩‍💻", "a&b"]) {
      expect(parseUser(new URLSearchParams({ u: raw }))).toBe(raw);
    }
  });

  it("**表示を壊す名前は落とす** (エラーにはしない。画像として読まれるので、描かないだけにする)", () => {
    for (const raw of ["a\u202eb", "a\nb", "山".repeat(49), "", " "]) {
      expect(parseUser(new URLSearchParams({ u: raw }))).toBeUndefined();
    }
  });
});

describe("図のユーザー名 (Issue #134。ADR-0024 の名前の行)", () => {
  it("**プロジェクト名・アイコン・ユーザー名の順に描く。ユーザー名に `@` は付けない**", async () => {
    const svg = await (await fetchDemo("?l=villagepump&u=taro")).text();

    expect(svg).toContain(">villagepump</text>");
    expect(svg).toContain(">taro</text>");
    expect(svg).not.toContain("@taro");
    expect(svg.indexOf(">villagepump<")).toBeLessThan(svg.indexOf(">taro<"));
  });

  it("**漢字や絵文字の名前も描く** (Issue #195)", async () => {
    const svg = await (await fetchDemo(`?u=${encodeURIComponent("山田 太郎👩‍💻")}`)).text();

    expect(svg).toContain(">山田 太郎👩‍💻</text>");
  });

  it("**SVG を壊そうとする名前はエスケープして描く** (中身の要素にならない)", async () => {
    const res = await fetchDemo(`?u=${encodeURIComponent('"><script>&')}`);
    const svg = await res.text();

    expect(res.status).toBe(200);
    expect(svg).toContain(">&quot;&gt;&lt;script&gt;&amp;</text>");
    expect(svg).not.toContain("<script");
  });

  it("**表示を壊す名前は描かず、既定の名前のまま** (エラーにはしない)", async () => {
    const res = await fetchDemo(`?u=${encodeURIComponent("a\u202eb")}`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(await (await fetchDemo()).text());
  });

  it("**長い名前でも外寸は変わらない** (草の右端で `…` に切る。`<img>` に寸法を固定した UserScript で縮まない)", async () => {
    const plain = size(await (await fetchDemo()).text());
    const long = size(await (await fetchDemo(`?u=${"山".repeat(48)}`)).text());

    expect(long).toEqual(plain);
    expect(await (await fetchDemo(`?u=${"山".repeat(48)}`)).text()).toContain("…</text>");
  });

  it("**名前が違えば ETag も違う**", async () => {
    const etags = await Promise.all(
      ["?u=aaa", "?u=bbb", ""].map(async (q) => (await fetchDemo(q)).headers.get("etag")),
    );

    expect(new Set(etags).size).toBe(3);
  });
});
