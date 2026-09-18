/**
 * 草の SVG を組み立てる (design §8)。
 *
 * `<img>` 経由で描画されるので完全に非インタラクティブで、外部フォントも外部 CSS も読めない。
 * すべてインラインで自己完結させる。
 *
 * **寸法・色・ラベルの位置は `src/worker/graph/layout.ts` が決める。** ここはそれを文字列にするだけ。
 * **草を描くのはこの経路だけ** (ADR-0019)。UserScript は数えて送るだけで、描かない。
 */
import { type GraphInput, type GraphLayout, layoutGraph } from "./graph/layout.ts";

/** 疎通確認と見た目の確認のために予約した publicId。 */
export const DEMO_PUBLIC_ID = "demo";

/**
 * SVG に出す文字列をエスケープする。原則として全部通す (design §6)。
 *
 * **プロジェクト名 (`?l=`) だけは外から来る** (Issue #119)。受け口の `isValidProjectName` が
 * 英字・数字・ハイフンしか通さないのでここに来る時点で危険な文字は無いが、**二重に塞ぐ**。
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
  const labels = layout.labels
    .map((label) => {
      const anchorAttr = label.anchor === "end" ? ' text-anchor="end"' : "";
      // 値は列挙 ("bold" だけ) なので、属性に入るのは固定の文字列
      const weightAttr = label.weight === undefined ? "" : ` font-weight="${label.weight}"`;
      return `<text x="${label.x}" y="${label.y}"${anchorAttr}${weightAttr}>${escapeXml(label.text)}</text>`;
    })
    .join("");

  // width / height / viewBox の 3 つを必ず出す。欠けると Cosense でサイズが崩れる (design §8)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<g data-part="labels" font-family="${layout.fontFamily}" font-size="${layout.fontSize}" fill="${layout.textColor}">${labels}</g>` +
    `<g data-part="grid">${layout.grid.map(cell).join("")}</g>` +
    `<g data-part="legend">${layout.legend.map(rect).join("")}</g>` +
    "</svg>"
  );
}

/** 草の SVG を返す。 */
export function renderGraph(input: GraphInput): string {
  return toSvg(layoutGraph(input));
}
