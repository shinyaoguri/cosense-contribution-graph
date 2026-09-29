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

describe("草の画像のユーザー名 (Issue #134)", () => {
  it("**プロジェクト名の後に、同じ `<text>` の `<tspan>` で `@<名前>` を続ける**", async () => {
    const svg = await (await fetchDemo("?l=villagepump&u=example-user")).text();

    expect(svg).toMatch(
      /<text x="8" y="\d+"><a href="https:\/\/scrapbox\.io\/villagepump"><tspan font-weight="bold">scrapbox\.io\/villagepump<\/tspan><\/a><tspan dx="6" [^>]*>@example-user<\/tspan><\/text>/,
    );
  });

  it("**ユーザー名は太字・濃い色にし、リンクにはしない** (2026-09-24。`<a>` の外の `<tspan>`)", async () => {
    const svg = await (await fetchDemo("?l=villagepump&u=example-user")).text();

    expect(svg).toContain(
      '</a><tspan dx="6" font-weight="bold" fill="#1f2328">@example-user</tspan>',
    );
    expect(svg.match(/<a /g)).toHaveLength(1);
  });

  it("**ダークでは濃い色の代わりに明るい色にする** (背景に沈まないように)", async () => {
    const svg = await (await fetchDemo("?l=villagepump&u=example-user&theme=dark")).text();

    expect(svg).toContain('font-weight="bold" fill="#e6edf3">@example-user</tspan>');
  });

  it("**プロジェクト名が無ければユーザー名だけを左端に描く** (太字・濃い色、リンクなし)", async () => {
    const svg = await (await fetchDemo("?u=example-user")).text();

    expect(svg).toMatch(
      /<text x="8" y="\d+" font-weight="bold" fill="#1f2328">@example-user<\/text>/,
    );
    expect(svg).not.toContain("<a ");
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
    const long = size(await (await fetchDemo(`?l=${"a".repeat(64)}&u=${"b".repeat(48)}`)).text());

    expect(Number(long.width)).toBeGreaterThan(Number(none.width));
    expect(long.height).toBe(none.height);
  });

  it("**漢字や絵文字の名前も `@<名前>` として描く** (Issue #195)", async () => {
    const svg = await (
      await fetchDemo(`?l=villagepump&u=${encodeURIComponent("山田 太郎👩‍💻")}`)
    ).text();

    expect(svg).toContain('font-weight="bold" fill="#1f2328">@山田 太郎👩‍💻</tspan>');
  });

  it("**SVG を壊そうとする名前はエスケープして描く** (中身の要素にならない)", async () => {
    const attack = '"><script>alert(1)</script>';
    const res = await fetchDemo(`?l=villagepump&u=${encodeURIComponent(attack)}`);
    const svg = await res.text();

    expect(res.status).toBe(200);
    expect(svg).toContain("@&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</tspan>");
    expect(svg).not.toContain("<script");
  });

  it("**表示を壊す名前は描かない** (エラーにはしない)", async () => {
    const res = await fetchDemo(`?l=villagepump&u=${encodeURIComponent("a\u202eb")}`);
    const svg = await res.text();

    expect(res.status).toBe(200);
    expect(svg).not.toContain("@");
  });

  it("**全角の名前は英数字より広く見積もり、凡例と重ならないように幅を広げる** (Issue #195)", async () => {
    const ascii = size(await (await fetchDemo(`?l=${"a".repeat(64)}&u=${"b".repeat(48)}`)).text());
    const wide = size(
      await (
        await fetchDemo(`?l=${"a".repeat(64)}&u=${encodeURIComponent("山".repeat(48))}`)
      ).text(),
    );

    expect(Number(wide.width)).toBeGreaterThan(Number(ascii.width));
  });

  it("**名前が違えば ETag も違う**", async () => {
    const etags = await Promise.all(
      ["?u=aaa", "?u=bbb", ""].map(async (q) => (await fetchDemo(q)).headers.get("etag")),
    );

    expect(new Set(etags).size).toBe(3);
  });
});
