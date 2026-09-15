/**
 * 草のレイアウトを DOM の SVG にする (design §9「表示」、段階 8、Issue #73)。
 *
 * - **寸法・色・ラベルの位置は `src/shared/graph-layout.ts` が決める。** 共有 SVG (`src/worker/svg.ts`) と同じなので見た目が食い違わない
 * - `createElementNS` で組み立てる。**innerHTML も DOMParser も使わない** (文言は `textContent`)
 * - **マスごとに `<title>` を付ける。** `<img>` の SVG では出ないが、ページの中の SVG ならブラウザがツールチップを出す
 * - **計測開始前のマスは塗らず点線の枠だけ**にする (共有 SVG と同じ。Issue #80)
 */
import type { GraphLayout } from "../shared/graph-layout.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

export type RenderOptions = {
  /** 表示の倍率。`width` / `height` だけを変え、`viewBox` はそのまま */
  readonly scale?: number;
  readonly label: string;
  /** マスのツールチップ */
  readonly tooltip: (day: string) => string;
  /** 計測開始前のマスのツールチップ。既定は「計測開始前」 */
  readonly beforeStartTooltip?: (day: string) => string;
};

export function renderGraphElement(
  doc: Document,
  layout: GraphLayout,
  options: RenderOptions,
): SVGSVGElement {
  const element = <K extends keyof SVGElementTagNameMap>(
    tag: K,
    attributes: Record<string, string | number>,
  ): SVGElementTagNameMap[K] => {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) {
      node.setAttribute(name, String(value));
    }
    return node;
  };

  const scale = options.scale ?? 1;
  const svg = element("svg", {
    width: layout.width * scale,
    height: layout.height * scale,
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    role: "img",
    "aria-label": options.label,
  });

  const rect = (swatch: { readonly x: number; readonly y: number; readonly fill: string }) =>
    element("rect", {
      x: swatch.x,
      y: swatch.y,
      width: layout.cellSize,
      height: layout.cellSize,
      rx: layout.cellRadius,
      fill: swatch.fill,
    });

  const labels = element("g", {
    "font-family": layout.fontFamily,
    "font-size": layout.fontSize,
    fill: layout.textColor,
  });
  for (const label of layout.labels) {
    const text = element("text", {
      x: label.x,
      y: label.y,
      ...(label.anchor === "end" ? { "text-anchor": "end" } : {}),
    });
    text.textContent = label.text;
    labels.append(text);
  }

  const grid = element("g", {});
  for (const cell of layout.grid) {
    // **計測開始前は塗らず点線の枠だけ** (活動の無い日と区別する。Issue #80)
    const node = cell.beforeStart
      ? element("rect", {
          x: cell.x,
          y: cell.y,
          width: layout.cellSize,
          height: layout.cellSize,
          rx: layout.cellRadius,
          fill: "none",
          stroke: layout.mutedColor,
          "stroke-dasharray": "1 1",
        })
      : rect(cell);
    const title = element("title", {});
    title.textContent = cell.beforeStart
      ? (options.beforeStartTooltip?.(cell.day) ?? `${cell.day} 計測開始前`)
      : options.tooltip(cell.day);
    node.append(title);
    grid.append(node);
  }

  const legend = element("g", {});
  legend.append(...layout.legend.map(rect));

  svg.append(labels, grid, legend);
  return svg;
}
