/**
 * カードの図の SVG を組み立てる (design §8、ADR-0024)。寸法と色は `graph/grass.ts` が決め、ここは文字列にするだけ。
 *
 * 草と同じく `<img>` で描かれるので、すべてインラインで自己完結させる。**アイコンも `data:` で埋め込む**
 * (`<img>` で読まれた SVG は外部の画像を読まない)。応答の CSP はカードだけ `img-src data:` を足す (`index.ts`)。
 * **本文を変えると ETag が変わる。** 属性とグループの順は `test/worker/card-golden.test.ts` が固定している。
 */
import { type GrassCell, type GrassInput, type GrassLayout, layoutGrass } from "./graph/grass.ts";
import { escapeXml } from "./xml.ts";

const n = (v: number) => Math.round(v * 100) / 100;

/** 角を丸めたマスの path。上のマスは上の角だけ、下のマスは下の角だけ、真ん中は四角 */
function cellPath(cell: GrassCell, w: number, h: number, r: number): string {
  const { x, y } = cell;
  if (cell.shape === "top") {
    return `M${x} ${n(y + h)}V${n(y + r)}A${r} ${r} 0 0 1 ${n(x + r)} ${y}H${n(x + w - r)}A${r} ${r} 0 0 1 ${n(x + w)} ${n(y + r)}V${n(y + h)}Z`;
  }
  if (cell.shape === "bottom") {
    return `M${x} ${y}H${n(x + w)}V${n(y + h - r)}A${r} ${r} 0 0 1 ${n(x + w - r)} ${n(y + h)}H${n(x + r)}A${r} ${r} 0 0 1 ${x} ${n(y + h - r)}Z`;
  }
  return `M${x} ${y}H${n(x + w)}V${n(y + h)}H${x}Z`;
}

function toSvg(layout: GrassLayout): string {
  const { width, height } = layout;
  const cell = (c: GrassCell) =>
    `<path d="${cellPath(c, layout.cellWidth, layout.cellHeight, layout.cellRadius)}" fill="${c.fill}"${c.opacity === undefined ? "" : ` fill-opacity="${c.opacity}"`}/>`;
  const text = (t: { x: number; y: number; text: string; anchor: string; fill: string }) =>
    `<text x="${t.x}" y="${t.y}"${t.anchor === "start" ? "" : ` text-anchor="${t.anchor}"`} fill="${t.fill}">${escapeXml(t.text)}</text>`;

  const { axis, name } = layout;
  const lines = axis.lines
    .map(
      (line) =>
        `<line x1="${line.x1}" y1="${axis.y}" x2="${line.x2}" y2="${axis.y}" stroke="${line.stroke}"/>`,
    )
    .join("");
  const axisNames =
    axis.names.length === 0
      ? ""
      : `<g data-part="axis-names" font-family="${layout.fontFamily}" font-size="${axis.nameSize}" letter-spacing="${axis.letterSpacing}">${axis.names.map(text).join("")}</g>`;

  const project =
    name.project === undefined
      ? ""
      : // **`<img>` で貼られている間は押せない** (research §3)。画像そのものを開いたときに効く
        `<a href="${escapeXml(name.project.href)}"><text x="${name.project.x}" y="${name.project.y}" font-size="${name.project.size}" font-weight="500" fill="${name.project.fill}">${escapeXml(name.project.text)}</text></a>`;
  const icon =
    name.icon === undefined
      ? ""
      : `<clipPath id="card-icon"><circle cx="${name.icon.cx}" cy="${name.icon.cy}" r="${name.icon.r}"/></clipPath>` +
        `<image href="${escapeXml(name.icon.href)}" x="${n(name.icon.cx - name.icon.r)}" y="${n(name.icon.cy - name.icon.r)}" width="${name.icon.r * 2}" height="${name.icon.r * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#card-icon)"/>`;
  const user =
    name.user === undefined
      ? ""
      : `<text x="${name.user.x}" y="${name.user.y}" font-size="${name.user.size}" fill="${name.user.fill}">${escapeXml(name.user.text)}</text>`;
  const mark = name.mark
    .map(
      (s) =>
        `<rect x="${s.x}" y="${s.y}" width="${name.markCellSize}" height="${name.markCellSize}" rx="${name.markCellRadius}" fill="${s.fill}"/>`,
    )
    .join("");
  const nameRow = mark + project + icon + user;

  // width / height / viewBox の 3 つを必ず出す。欠けると Cosense でサイズが崩れる (design §8)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<g data-part="labels" font-family="${layout.fontFamily}" font-size="${layout.fontSize}">${layout.labels.map(text).join("")}</g>` +
    `<g data-part="grid">${layout.grid.map(cell).join("")}</g>` +
    `<g data-part="sum">${layout.sum.map(cell).join("")}</g>` +
    `<g data-part="axis" stroke-width="${axis.strokeWidth}" stroke-linecap="round">${lines}</g>` +
    axisNames +
    // 名前が無ければ (合算の印も無ければ) グループごと省く
    (nameRow === ""
      ? ""
      : `<g data-part="name" font-family="${layout.fontFamily}">${nameRow}</g>`) +
    "</svg>"
  );
}

/** カードの図の SVG を返す。 */
export function renderGrass(input: GrassInput): string {
  return toSvg(layoutGrass(input));
}
