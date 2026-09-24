/**
 * 草の SVG を組み立てる (design §8)。
 *
 * `<img>` 経由で描画されるので完全に非インタラクティブで、外部フォントも外部 CSS も読めない。
 * すべてインラインで自己完結させる。
 *
 * **寸法・色・ラベルの位置は `src/worker/graph/layout.ts` が決める。** ここはそれを文字列にするだけ。
 * **草を描くのはこの経路だけ** (ADR-0019)。UserScript は数えて送るだけで、描かない。
 */
import { type GraphInput, type GraphLayout, layoutGraph, SUFFIX_GAP } from "./graph/layout.ts";

/** 疎通確認と見た目の確認のために予約した publicId。 */
export const DEMO_PUBLIC_ID = "demo";

/**
 * SVG に出す文字列をエスケープする。原則として全部通す (design §6)。
 *
 * **プロジェクト名 (`?l=`) とユーザー名 (`?u=`) だけは外から来る** (Issue #119・#134)。受け口の
 * `isValidProjectName` / `isValidUserName` が英字・数字・ハイフンしか通さないのでここに来る時点で
 * 危険な文字は無いが、**二重に塞ぐ**。
 */
function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * レイアウトを SVG の文字列にする。
 *
 * **本文を変えると ETag が変わる** (ADR-0015 決定 2)。属性とグループの順は `test/worker/svg-golden.test.ts` が固定している。
 */
function toSvg(layout: GraphLayout): string {
  const { width, height, cellSize, cellRadius } = layout;
  const rect = (swatch: { readonly x: number; readonly y: number; readonly fill: string }) =>
    `<rect x="${swatch.x}" y="${swatch.y}" width="${cellSize}" height="${cellSize}" rx="${cellRadius}" fill="${swatch.fill}"/>`;
  // **計測開始前は塗らず点線の枠だけ** (活動の無い日と区別する。Issue #80)
  const cell = (swatch: {
    readonly x: number;
    readonly y: number;
    readonly fill: string;
    readonly beforeStart: boolean;
  }) =>
    swatch.beforeStart
      ? `<rect x="${swatch.x}" y="${swatch.y}" width="${cellSize}" height="${cellSize}" rx="${cellRadius}" fill="none" stroke="${layout.mutedColor}" stroke-dasharray="1 1"/>`
      : rect(swatch);
  const markCell = (swatch: { readonly x: number; readonly y: number; readonly fill: string }) =>
    `<rect x="${swatch.x}" y="${swatch.y}" width="${layout.markCellSize}" height="${layout.markCellSize}" rx="${layout.markCellRadius}" fill="${swatch.fill}"/>`;
  const labels = layout.labels
    .map((label) => {
      const anchorAttr = label.anchor === "end" ? ' text-anchor="end"' : "";
      // 値は列挙 ("bold" だけ) なので、属性に入るのは固定の文字列
      // 色も固定の値 (layout.ts の定数) だけ
      const weightAttr =
        (label.weight === undefined ? "" : ` font-weight="${label.weight}"`) +
        (label.fill === undefined ? "" : ` fill="${label.fill}"`);
      const link = (inner: string) =>
        // **`<img>` で貼られている間は押せない** (research §3)。画像そのものを開いたときに効く
        label.href === undefined ? inner : `<a href="${escapeXml(label.href)}">${inner}</a>`;
      const position = `x="${label.x}" y="${label.y}"${anchorAttr}`;
      if (label.suffix === undefined) {
        return link(`<text ${position}${weightAttr}>${escapeXml(label.text)}</text>`);
      }
      // **続きは太字・濃い色で、リンクにはしない** (Issue #134、2026-09-24)。同じ `<text>` に並べ、
      // 位置はブラウザに任せる。リンクは前半の `<tspan>` だけに掛ける (SVG 2 は `<text>` の中の `<a>` を許す)
      const head = link(`<tspan${weightAttr}>${escapeXml(label.text)}</tspan>`);
      return `<text ${position}>${head}<tspan dx="${SUFFIX_GAP}" font-weight="bold" fill="${label.suffix.fill}">${escapeXml(label.suffix.text)}</tspan></text>`;
    })
    .join("");

  // width / height / viewBox の 3 つを必ず出す。欠けると Cosense でサイズが崩れる (design §8)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<g data-part="labels" font-family="${layout.fontFamily}" font-size="${layout.fontSize}" fill="${layout.textColor}">${labels}</g>` +
    `<g data-part="grid">${layout.grid.map(cell).join("")}</g>` +
    `<g data-part="legend">${layout.legend.map(rect).join("")}</g>` +
    // **合算の印は合算の草にだけ出す。** ほかの草の本文 (と ETag) を変えないよう、グループごと省く
    (layout.mark.length === 0
      ? ""
      : `<g data-part="mark">${layout.mark.map(markCell).join("")}</g>`) +
    "</svg>"
  );
}

/** 草の SVG を返す。 */
export function renderGraph(input: GraphInput): string {
  return toSvg(layoutGraph(input));
}
