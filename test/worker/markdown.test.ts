import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/worker/markdown.ts";

describe("ブロック", () => {
  it.each([
    ["# 題", "<h1>題</h1>"],
    ["## 節", "<h2>節</h2>"],
    ["### 小節", "<h3>小節</h3>"],
    ["---", "<hr>"],
  ])("%s → %s", (source, expected) => {
    expect(renderMarkdown(source)).toBe(expected);
  });

  it("**段落は空行で切れ、中の改行は残す**", () => {
    expect(renderMarkdown("一行目\n二行目\n\n次の段落")).toBe(
      "<p>一行目\n二行目</p>\n<p>次の段落</p>",
    );
  });

  it("**箇条書きの続きの行は同じ項目につなぐ**", () => {
    expect(renderMarkdown("- 一つ目\n  続き\n- 二つ目")).toBe(
      "<ul>\n<li>一つ目\n続き</li>\n<li>二つ目</li>\n</ul>",
    );
  });

  it("**表は区切り行の前を見出しにする**", () => {
    expect(renderMarkdown("| 項目 | 形 |\n|---|---|\n| uid | 27 文字 |")).toBe(
      "<table>\n<tr><th>項目</th><th>形</th></tr>\n<tr><td>uid</td><td>27 文字</td></tr>\n</table>",
    );
  });

  it("区切り行の無い表は全部が本文", () => {
    expect(renderMarkdown("| a | b |")).toBe("<table>\n<tr><td>a</td><td>b</td></tr>\n</table>");
  });
});

describe("インライン", () => {
  it.each([
    ["**強い**", "<p><strong>強い</strong></p>"],
    ["`コード`", "<p><code>コード</code></p>"],
    ["[草](https://example.com/x)", '<p><a href="https://example.com/x">草</a></p>'],
  ])("%s → %s", (source, expected) => {
    expect(renderMarkdown(source)).toBe(expected);
  });

  it("**表のセルにも効く**", () => {
    expect(renderMarkdown("| **強い** |")).toContain("<td><strong>強い</strong></td>");
  });
});

describe("安全側に倒す", () => {
  it("**本文の HTML はタグにしない**", () => {
    expect(renderMarkdown('<script>alert("x")</script>')).toBe(
      "<p>&#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;</p>",
    );
  });

  it("**`javascript:` のリンクは作らない**", () => {
    const html = renderMarkdown("[押して](javascript:alert(1))");

    expect(html).not.toContain("<a ");
    expect(html).toContain("押して");
  });

  it.each(["mailto:a@example.com", "/local", "data:text/html,x"])(
    "http(s) 以外 (%s) もリンクにしない",
    (href) => {
      expect(renderMarkdown(`[文字](${href})`)).not.toContain("<a ");
    },
  );

  it("**属性を閉じる引用符を本文から差し込めない**", () => {
    // ラベルもエスケープ済みなので、属性の外に出られない
    expect(renderMarkdown('["><img src=x>](https://example.com)')).toContain(
      '<a href="https://example.com">&#34;&#62;&#60;img src=x&#62;</a>',
    );
  });
});
