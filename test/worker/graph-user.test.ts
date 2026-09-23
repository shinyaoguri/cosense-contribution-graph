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

describe("草の画像のユーザー名 (Issue #134)", () => {
  it("**プロジェクト名の後に、同じ `<text>` の `<tspan>` で `@<名前>` を続ける**", async () => {
    const svg = await (await fetchDemo("?l=villagepump&u=example-user")).text();

    expect(svg).toMatch(
      /<text x="8" y="\d+"><a href="https:\/\/scrapbox\.io\/villagepump"><tspan font-weight="bold">scrapbox\.io\/villagepump<\/tspan><\/a><tspan dx="6">@example-user<\/tspan><\/text>/,
    );
  });

  it("**ユーザー名は太字にもリンクにもしない** (`<a>` の外、`font-weight` の無い `<tspan>`)", async () => {
    const svg = await (await fetchDemo("?l=villagepump&u=example-user")).text();

    expect(svg).toContain('</a><tspan dx="6">@example-user</tspan>');
    expect(svg.match(/<a /g)).toHaveLength(1);
  });

  it("**合算 (プロジェクト名なし) ではユーザー名だけを左端に描く**", async () => {
    const svg = await (await fetchDemo("?u=example-user")).text();

    expect(svg).toMatch(/<text x="8" y="\d+">@example-user<\/text>/);
    expect(svg).not.toContain("<a ");
    expect(svg).not.toContain("font-weight");
  });

  it("**プロジェクト名だけなら今までと 1 文字も変わらない** (既存の画像の ETag を変えない)", async () => {
    const svg = await (await fetchDemo("?l=villagepump")).text();

    expect(svg).toContain('<a href="https://scrapbox.io/villagepump"><text x="8" y="');
    expect(svg).not.toContain("<tspan");
  });

  it("**ふつうの長さの名前なら寸法は変わらない** (`<img>` に寸法を固定した UserScript で縮まない)", async () => {
    const none = size(await (await fetchDemo()).text());
    const both = size(await (await fetchDemo("?l=villagepump&u=example-user")).text());
    const user = size(await (await fetchDemo("?u=example-user")).text());

    expect(both).toEqual(none);
    expect(user).toEqual(none);
  });

  it("**両方が長いときは凡例と重ならないように幅を広げる**", async () => {
    const none = size(await (await fetchDemo()).text());
    const long = size(await (await fetchDemo(`?l=${"a".repeat(64)}&u=${"b".repeat(64)}`)).text());

    expect(Number(long.width)).toBeGreaterThan(Number(none.width));
    expect(long.height).toBe(none.height);
  });

  it("**形の違う名前は描かない** (エラーにはしない)", async () => {
    const attack = '"><script>alert(1)</script>';
    const res = await fetchDemo(`?l=villagepump&u=${encodeURIComponent(attack)}`);
    const svg = await res.text();

    expect(res.status).toBe(200);
    expect(svg).not.toContain("script");
    expect(svg).not.toContain("@");
  });

  it("**名前が違えば ETag も違う**", async () => {
    const etags = await Promise.all(
      ["?u=aaa", "?u=bbb", ""].map(async (q) => (await fetchDemo(q)).headers.get("etag")),
    );

    expect(new Set(etags).size).toBe(3);
  });
});
