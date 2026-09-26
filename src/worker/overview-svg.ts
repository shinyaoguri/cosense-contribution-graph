/**
 * 活動の概観の SVG を組み立てる (design §8、ADR-0021)。寸法と色は `graph/overview.ts` が決め、ここは文字列にするだけ。
 *
 * 草と同じく `<img>` で描かれるので、すべてインラインで自己完結させる。
 * **本文を変えると ETag が変わる。** 属性とグループの順は `test/worker/overview-golden.test.ts` が固定している。
 */
import { layoutOverview, type OverviewInput, type OverviewLayout } from "./graph/overview.ts";
import { escapeXml } from "./svg.ts";

/** % の前の間隔 */
const PERCENT_GAP = 4;
/** 四角形の線の太さ (GitHub と同じ) */
const SHAPE_STROKE = 7;
const SHAPE_OPACITY = 0.5;
const AXIS_STROKE = 2;
const VERTEX_RADIUS = 3;
const VERTEX_STROKE = 2;

function toSvg(layout: OverviewLayout): string {
  const { width, height } = layout;
  const axes = layout.axes
    .map(
      ({ from, to }) =>
        `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="${layout.axisColor}" stroke-width="${AXIS_STROKE}" stroke-linecap="round"/>`,
    )
    .join("");
  const shape =
    layout.shape === undefined
      ? ""
      : `<g data-part="shape"><polygon points="${layout.shape.map((p) => `${p.x},${p.y}`).join(" ")}" fill="${layout.shapeColor}" stroke="${layout.shapeColor}" stroke-width="${SHAPE_STROKE}" stroke-linejoin="round" opacity="${SHAPE_OPACITY}"/>` +
        layout.vertices
          .map(
            (p) =>
              `<circle cx="${p.x}" cy="${p.y}" r="${VERTEX_RADIUS}" fill="${layout.vertexFill}" stroke="${layout.shapeColor}" stroke-width="${VERTEX_STROKE}"/>`,
          )
          .join("") +
        "</g>";
  const labels = layout.labels
    .map((label) => {
      const anchor = label.anchor === "start" ? "" : ` text-anchor="${label.anchor}"`;
      const percent =
        label.percent === undefined
          ? ""
          : `<tspan dx="${PERCENT_GAP}" font-weight="bold">${label.percent}%</tspan>`;
      return `<text x="${label.x}" y="${label.y}"${anchor}>${escapeXml(label.name)}${percent}</text>`;
    })
    .join("");

  // width / height / viewBox の 3 つを必ず出す。欠けると Cosense でサイズが崩れる (design §8)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<g data-part="axes">${axes}</g>` +
    shape +
    `<g data-part="labels" font-family="${layout.fontFamily}" font-size="${layout.fontSize}" fill="${layout.textColor}">${labels}</g>` +
    "</svg>"
  );
}

/** 活動の概観の SVG を返す。 */
export function renderOverview(input: OverviewInput): string {
  return toSvg(layoutOverview(input));
}
