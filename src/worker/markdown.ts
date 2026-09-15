/**
 * Markdown の**部分集合**を HTML にする (ADR-0018、Issue #88)。
 * `docs/privacy.md` を正本のまま `/privacy` で配信するためだけにある。
 *
 * **汎用の Markdown 実装ではない。** 扱うのは、この 1 ファイルが実際に使う記法だけ:
 *
 * - 見出し (`#`〜`###`)、段落、水平線 (`---`)
 * - 箇条書き (`- `。続きの行はインデントでつなぐ)
 * - 表 (`|` 区切り。2 行目が区切り行なら 1 行目が見出し)
 * - インライン: `**強調**`、`` `コード` ``、`[文字](URL)`
 *
 * **依存は増やさない** (パーサを 1 つ入れると、その更新と脆弱性を抱える)。
 * 足りない記法が要るようになったら、ここに足すか、正本の書き方を合わせる。
 *
 * **エスケープを先にする。** 後から HTML を組み立てるので、本文由来のタグは残らない。
 * リンクは `http(s)` だけを通す (`javascript:` を弾く)。
 */

/** 表の区切り行 (`|---|---|`)。 */
const TABLE_DIVIDER = /^\|[\s:|-]+\|$/;

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];
  let rows: string[][] = [];
  let headerRow = false;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      html.push(`<p>${inline(paragraph.join("\n"))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (items.length > 0) {
      html.push(`<ul>\n${items.map((item) => `<li>${inline(item)}</li>`).join("\n")}\n</ul>`);
      items = [];
    }
  };
  const flushTable = () => {
    if (rows.length > 0) {
      const body = rows.map((cells, index) => {
        const tag = headerRow && index === 0 ? "th" : "td";
        return `<tr>${cells.map((cell) => `<${tag}>${inline(cell)}</${tag}>`).join("")}</tr>`;
      });
      html.push(`<table>\n${body.join("\n")}\n</table>`);
      rows = [];
      headerRow = false;
    }
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (const line of lines) {
    if (line.trim() === "") {
      flushAll();
      continue;
    }
    if (line.startsWith("|")) {
      flushParagraph();
      flushList();
      if (TABLE_DIVIDER.test(line.trim())) {
        // 区切り行の前の 1 行が見出し
        headerRow = rows.length === 1;
        continue;
      }
      rows.push(cellsOf(line));
      continue;
    }
    flushTable();

    const heading = /^(#{1,3}) +(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1]?.length ?? 1;
      html.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);
      continue;
    }
    if (/^-{3,}$/.test(line.trim())) {
      flushAll();
      html.push("<hr>");
      continue;
    }
    if (line.startsWith("- ")) {
      flushParagraph();
      items.push(line.slice(2));
      continue;
    }
    // 箇条書きの続き (インデントされた行) は直前の項目につなぐ
    if (items.length > 0 && /^\s+\S/.test(line)) {
      items[items.length - 1] = `${items[items.length - 1] ?? ""}\n${line.trim()}`;
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushAll();
  return html.join("\n");
}

function cellsOf(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** **エスケープしてから**組み立てる。順は コード → 強調 → リンク。 */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, (_match, code: string) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_match, bold: string) => `<strong>${bold}</strong>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, href: string) =>
      // `javascript:` などを弾く。エスケープ済みなので href をそのまま属性に置ける
      /^https?:\/\//.test(href) ? `<a href="${href}">${label}</a>` : match,
    );
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
