/**
 * 草のダイアログの「草と活動の概観の見方」に添える図 (Issue #182)。**具体例に注釈を付けた静的な絵**で、記録を読まない。
 *
 * - **描くのは Worker** (ADR-0019)。UserScript は `<img>` で貼るだけ。色はスキーム、レーダーは `layoutOverview` の
 *   実物から作るので、**図の色と形が実際の草・概観とずれない**
 * - **ライト・既定の配色に固定する。** ダイアログは常にライトで (research §3)、UserScript は配色を選ばない
 * - 草と同じく `<img>` で描かれるので、すべてインラインで自己完結させる
 */
import { GUIDE_HEIGHTS, GUIDE_WIDTH, type GuideName, isGuideName } from "../shared/guide.ts";
import type { AxisTotals } from "./graph/axes.ts";
import type { Level } from "./graph/scale.ts";
import { DEFAULT_SCHEME, schemeOf } from "./graph/scheme.ts";
import { FONT_FAMILY, MUTED_COLOR, TEXT_COLOR } from "./graph/style.ts";
import { renderOverview } from "./overview-svg.ts";
import { escapeXml } from "./xml.ts";

export const GUIDE_PATH = /^\/v1\/guide\/([^/]+)\.svg$/;

/**
 * **毎回 ETag で確かめ直させる** (favicon と同じ。#186)。絵はデプロイでしか変わらないが、
 * `max-age` を付けると ETag を確かめるのは期限が切れた後だけなので、配色を変えても古い図が残る。
 * 変わっていなければ 304 で本文を送らない。
 */
export const GUIDE_CACHE_CONTROL = "public, no-cache";

const THEME = "light";
const SCHEME = schemeOf(DEFAULT_SCHEME);
const TEXT = TEXT_COLOR[THEME];
const MUTED = MUTED_COLOR[THEME];
/** 見出しと強調の文字色 (GitHub の fg.default。草のユーザー名と同じ) */
const STRONG = "#1f2328";
const FONT_SIZE = 12;
const SMALL = 11;

/** バランスの見本。スキームの凡例の列と同じ (読み寄り → 書き寄り) */
const BALANCES = SCHEME.legendBalances;
const READ_BALANCE = BALANCES[0] ?? -1;
const WRITE_BALANCE = BALANCES[BALANCES.length - 1] ?? 1;

export function cellColor(level: Level, balance: number): string {
  return SCHEME.cell({ level, balance }, THEME);
}

/** 読んだ・書いたの見本の色。概観の塗りと同じ段 (Level 3) */
const WRITE_COLOR = cellColor(3, WRITE_BALANCE);
const READ_COLOR = cellColor(3, READ_BALANCE);
const EMPTY_COLOR = cellColor(0, 0);

/**
 * 「読んだ」「書いた」の文字の色。**マスの色をそのまま文字に使わない** — 琥珀はもともと明るいので、
 * 白地で Level 3 は 2.4:1、Level 4 でも 3.8:1 しかない。読み寄りは Level 4 の紫 (8.0:1)、
 * 書き寄りは Level 4 の琥珀を同じ色相のまま 4.5:1 を超えるまで暗くした色 (4.9:1) にする (ADR-0023)
 */
const READ_TEXT = cellColor(4, READ_BALANCE);
const WRITE_TEXT = "#946900";

type TextOptions = {
  readonly anchor?: "start" | "middle" | "end";
  readonly weight?: "bold";
  readonly fill?: string;
  readonly size?: number;
};

function text(x: number, y: number, body: string, options: TextOptions = {}): string {
  const anchor =
    options.anchor === undefined || options.anchor === "start"
      ? ""
      : ` text-anchor="${options.anchor}"`;
  const weight = options.weight === undefined ? "" : ` font-weight="${options.weight}"`;
  const fill = options.fill === undefined ? "" : ` fill="${options.fill}"`;
  const size = options.size === undefined ? "" : ` font-size="${options.size}"`;
  return `<text x="${x}" y="${y}"${anchor}${weight}${fill}${size}>${escapeXml(body)}</text>`;
}

function rect(x: number, y: number, size: number, fill: string, radius = 3): string {
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${radius}" fill="${fill}"/>`;
}

/** 数えない分のマス。草の「計測開始前」と同じ点線の枠 */
function emptyRect(x: number, y: number, size: number, radius = 3): string {
  return `<rect x="${x + 0.5}" y="${y + 0.5}" width="${size - 1}" height="${size - 1}" rx="${radius}" fill="none" stroke="${TEXT}" stroke-dasharray="2 2"/>`;
}

function line(x1: number, y1: number, x2: number, y2: number, color = TEXT): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1"/>`;
}

/** 範囲を示す角括弧。`up` なら下向きの脚 (上から範囲を指す) */
function bracket(x1: number, x2: number, y: number, up: boolean, color = TEXT): string {
  const leg = up ? 5 : -5;
  return `<path d="M${x1} ${y + leg}V${y}H${x2}V${y + leg}" fill="none" stroke="${color}" stroke-width="1"/>`;
}

/** 注釈の引き出し線と、指す先の小さな点 */
function pointer(x1: number, y1: number, x2: number, y2: number): string {
  return `${line(x1, y1, x2, y2)}<circle cx="${x2}" cy="${y2}" r="2" fill="${TEXT}"/>`;
}

/** 番号の丸 (図の中の例と、下の説明を結ぶ) */
function badge(x: number, y: number, n: number): string {
  return (
    `<circle cx="${x}" cy="${y}" r="8" fill="${STRONG}"/>` +
    text(x, y + 4, String(n), { anchor: "middle", weight: "bold", fill: "#ffffff", size: SMALL })
  );
}

function svg(name: GuideName, body: string): string {
  const height = GUIDE_HEIGHTS[name];
  // width / height / viewBox の 3 つを必ず出す。欠けると Cosense でサイズが崩れる (design §8)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${GUIDE_WIDTH}" height="${height}" viewBox="0 0 ${GUIDE_WIDTH} ${height}">` +
    `<g font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${TEXT}">${body}</g>` +
    "</svg>"
  );
}

type MinuteKind = "write" | "read" | "none";

/**
 * 「数えているもの」の例の 20 分 (10:00〜10:19)。書いた 6 分 + 読んだ 9 分 = 15 分。
 * 10:05 は読みながら編集した分で、「同じ分に両方あれば書いた」の例にする
 */
const EXAMPLE_MINUTES: readonly MinuteKind[] = [
  ...Array<MinuteKind>(3).fill("read"),
  ...Array<MinuteKind>(6).fill("write"),
  ...Array<MinuteKind>(3).fill("read"),
  ...Array<MinuteKind>(3).fill("none"),
  ...Array<MinuteKind>(3).fill("read"),
  ...Array<MinuteKind>(2).fill("none"),
];

function minutesSvg(): string {
  const cell = 22;
  const step = 26;
  const left = 60;
  const stripY = 74;
  const x = (i: number) => left + i * step;
  const mid = (from: number, to: number) => (x(from) + x(to) + cell) / 2;

  const cells = EXAMPLE_MINUTES.map((kind, i) =>
    kind === "none"
      ? emptyRect(x(i), stripY, cell)
      : rect(x(i), stripY, cell, kind === "write" ? WRITE_COLOR : READ_COLOR),
  ).join("");
  const ticks = [0, 10, 15, 19]
    .map((i) =>
      text(x(i) + cell / 2, stripY + cell + 14, `10:${String(i).padStart(2, "0")}`, {
        anchor: "middle",
        size: SMALL,
      }),
    )
    .join("");

  // 上の注釈: 読んだ・書いた・読んだ
  const above = (from: number, to: number, head: string, note: string, fill: string) =>
    bracket(x(from), x(to) + cell, stripY - 8, true) +
    text(mid(from, to), stripY - 30, head, { anchor: "middle", weight: "bold", fill }) +
    text(mid(from, to), stripY - 15, note, { anchor: "middle", size: SMALL });
  // 下の注釈: 数えない
  const below = (from: number, to: number, head: string, note: string) =>
    bracket(x(from), x(to) + cell, stripY + cell + 22, false) +
    text(mid(from, to), stripY + cell + 38, head, {
      anchor: "middle",
      weight: "bold",
      fill: STRONG,
    }) +
    text(mid(from, to), stripY + cell + 52, note, { anchor: "middle", size: SMALL });

  const both = 5;
  const bothNote =
    pointer(x(both) + cell / 2, stripY + cell + 30, x(both) + cell / 2, stripY + cell / 2) +
    text(x(both) + cell / 2, stripY + cell + 44, "読みながら編集した分も", {
      anchor: "middle",
      size: SMALL,
    }) +
    text(x(both) + cell / 2, stripY + cell + 58, "「書いた」に数える", {
      anchor: "middle",
      size: SMALL,
    });

  const sumY = 196;
  const sum =
    line(20, sumY - 18, GUIDE_WIDTH - 20, sumY - 18, MUTED) +
    rect(20, sumY - 11, 14, WRITE_COLOR, 2) +
    text(40, sumY, "書いた 6 分", { fill: STRONG }) +
    text(112, sumY, "+") +
    rect(128, sumY - 11, 14, READ_COLOR, 2) +
    text(148, sumY, "読んだ 9 分", { fill: STRONG }) +
    text(220, sumY, "=") +
    text(236, sumY, "この 20 分の活動は 15 分", { weight: "bold", fill: STRONG }) +
    text(GUIDE_WIDTH - 20, sumY, "1 日ぶんを足したものが草の 1 マスになる", {
      anchor: "end",
      size: SMALL,
    });

  return svg(
    "minutes",
    text(20, 18, "例: ある日の 10:00〜10:19 (1 マス = 1 分)", { weight: "bold", fill: STRONG }) +
      above(0, 2, "読んだ", "見ていて操作した", READ_TEXT) +
      above(3, 8, "書いた", "ページを編集した", WRITE_TEXT) +
      above(9, 11, "読んだ", "スクロールなど", READ_TEXT) +
      above(15, 17, "読んだ", "", READ_TEXT) +
      below(12, 14, "数えない", "3 分操作が無い") +
      below(18, 19, "数えない", "別のタブへ") +
      bothNote +
      `<g data-part="minutes">${cells}</g>` +
      ticks +
      sum,
  );
}

/**
 * 草の例の 8 週。1 列が 1 週 (上が日曜) で、1 文字目が Level、2 文字目が色合い
 * (r 読み寄り・b やや読み・m ふだん・p やや書き・w 書き寄り)。`0` は 3 分未満の日
 */
const EXAMPLE_WEEKS = [
  "0  1r 2b 0  2m 1b 0 ",
  "1b 3m 2p 3b 0  2r 1m",
  "0  2m 3p 3p 2m 1r 0 ",
  "2b 1r 3m 2p 3b 3b 1m",
  "1m 3r 2m 3m 3w 2b 0 ",
  "0  2b 4w 3p 2m 1r 1m",
  "2m 3b 3m 2p 4p 3b 0 ",
  "1r 2m 3p 4m 2b 1r 0 ",
];
const TONES: Record<string, number> = { r: -1, b: -0.4, m: 0, p: 0.4, w: 1 };

/** 例の 1 日の [Level, バランス] */
function exampleDay(column: number, row: number): readonly [Level, number] {
  const token = EXAMPLE_WEEKS[column]?.slice(row * 3, row * 3 + 2) ?? "0 ";
  const level = Number(token[0]) as Level;
  return [level, TONES[token[1] ?? ""] ?? 0];
}

/** ① よく書いた日 (列, 行)、② 少し読んだだけの日 */
const EXAMPLE_HEAVY = [5, 2] as const;
const EXAMPLE_LIGHT = [3, 1] as const;

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function grassSvg(): string {
  // 左: 小さな草
  const cell = 18;
  const step = 22;
  const gridX = 48;
  const gridY = 60;
  const gx = (column: number) => gridX + column * step;
  const gy = (row: number) => gridY + row * step;
  const grid = EXAMPLE_WEEKS.flatMap((_, column) =>
    WEEKDAYS.map((_, row) => {
      const [level, balance] = exampleDay(column, row);
      return rect(gx(column), gy(row), cell, cellColor(level, balance));
    }),
  ).join("");
  const weekdays = WEEKDAYS.map((day, row) =>
    text(gridX - 8, gy(row) + 13, day, { anchor: "end", size: SMALL }),
  ).join("");
  // 1 マス = 1 日 (左上の 1 マスを囲む)、1 列 = 1 週間 (右の列を上から括る)
  const outline = (column: number, row: number) =>
    `<rect x="${gx(column) - 2}" y="${gy(row) - 2}" width="${cell + 4}" height="${cell + 4}" rx="4" fill="none" stroke="${STRONG}" stroke-width="1.5"/>`;
  const weekColumn = 6;
  const guides =
    outline(0, 0) +
    pointer(gx(0) + cell / 2, gridY - 20, gx(0) + cell / 2, gy(0) - 2) +
    text(gx(0), gridY - 26, "1 マス = 1 日", { size: SMALL, fill: STRONG }) +
    bracket(gx(weekColumn), gx(weekColumn) + cell, gridY - 6, true) +
    line(gx(weekColumn) + cell / 2, gridY - 6, gx(weekColumn) + cell / 2, gridY - 20) +
    text(gx(weekColumn) + cell / 2, gridY - 26, "1 列 = 1 週間", {
      anchor: "middle",
      size: SMALL,
      fill: STRONG,
    });
  // 例の日は枠で囲み、角に番号を付ける (マスの色を隠さない)
  const example = ([column, row]: readonly [number, number], n: number) =>
    outline(column, row) + badge(gx(column) + cell + 1, gy(row) - 1, n);

  // 右: 色の読み方 (縦が量、横が読み書き)
  const key = 24;
  const keyStep = 28;
  const keyX = 360;
  const keyY = 60;
  const levels: readonly Level[] = [4, 3, 2, 1];
  const kx = (column: number) => keyX + column * keyStep;
  const ky = (row: number) => keyY + row * keyStep;
  const swatches = levels
    .flatMap((level, row) =>
      BALANCES.map((balance, column) => rect(kx(column), ky(row), key, cellColor(level, balance))),
    )
    .join("");
  const keyRight = kx(BALANCES.length - 1) + key;
  const keyBottom = ky(levels.length - 1) + key;
  const keyMiddle = keyX + (keyRight - keyX) / 2;
  const arrow = (x1: number, y1: number, x2: number, y2: number) =>
    `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${TEXT}" stroke-width="1" marker-end="url(#arrow)"/>`;
  const keyLabels =
    text(keyMiddle, keyY - 26, "色の読み方", { anchor: "middle", weight: "bold", fill: STRONG }) +
    // 縦: 量
    arrow(keyX - 10, keyBottom, keyX - 10, keyY + 2) +
    text(keyX - 16, keyY + 12, "多い", { anchor: "end", size: SMALL }) +
    text(keyX - 16, keyBottom - 2, "少ない", { anchor: "end", size: SMALL }) +
    text(keyX - 16, keyY + (keyBottom - keyY) / 2 + 4, "濃さ = 量", {
      anchor: "end",
      weight: "bold",
      fill: STRONG,
    }) +
    // 横: 読み書き
    arrow(keyMiddle - 22, keyBottom + 14, keyX + 2, keyBottom + 14) +
    arrow(keyMiddle + 22, keyBottom + 14, keyRight - 2, keyBottom + 14) +
    text(keyMiddle, keyBottom + 18, "ふだん", { anchor: "middle", size: SMALL }) +
    text(keyX, keyBottom + 32, "読み寄り", { fill: READ_TEXT, weight: "bold" }) +
    text(keyRight, keyBottom + 32, "書き寄り", {
      anchor: "end",
      fill: WRITE_TEXT,
      weight: "bold",
    }) +
    text(keyMiddle, keyBottom + 50, "色合い = 読み書きの比率", {
      anchor: "middle",
      weight: "bold",
      fill: STRONG,
    }) +
    // 色なし
    rect(keyRight + 20, keyBottom - key, key, EMPTY_COLOR) +
    text(keyRight + 20 + key + 6, keyBottom - key + 10, "色なし", { size: SMALL, fill: STRONG }) +
    text(keyRight + 20 + key + 6, keyBottom - key + 24, "3 分未満", { size: SMALL });

  const notesY = 262;
  const notes =
    line(20, notesY - 22, GUIDE_WIDTH - 20, notesY - 22, MUTED) +
    badge(28, notesY - 4, 1) +
    text(44, notesY, "よく書いた日: 量が多いので濃く、書いた分が多いので黄色", { fill: STRONG }) +
    badge(28, notesY + 20, 2) +
    text(44, notesY + 24, "少し読んだだけの日: 量が少ないので薄く、読んだ分が多いので紫", {
      fill: STRONG,
    });

  return svg(
    "grass",
    `<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L8 4L0 8z" fill="${TEXT}"/></marker></defs>` +
      text(20, 18, "例: ある 8 週間の草", { weight: "bold", fill: STRONG }) +
      weekdays +
      `<g data-part="grid">${grid}</g>` +
      guides +
      example(EXAMPLE_HEAVY, 1) +
      example(EXAMPLE_LIGHT, 2) +
      `<g data-part="key">${swatches}</g>` +
      keyLabels +
      notes,
  );
}

/** 概観の例の分。**読むが最も多い** — 読む時間が長いのはふつうのことで、実際の概観もたいていこの形になる */
const EXAMPLE_TOTALS: AxisTotals = { read: 240, grow: 90, join: 40, create: 30 };

const OVERVIEW_ROWS = [
  { key: "read", name: "読む", note: "読んだだけ" },
  { key: "grow", name: "育てる", note: "前に作った自分のページに書いた" },
  { key: "join", name: "関わる", note: "他の人が作ったページに書いた" },
  { key: "create", name: "作る", note: "その日に作ったページに書いた" },
] as const satisfies readonly { key: keyof AxisTotals; name: string; note: string }[];

function overviewSvg(): string {
  const tableX = 20;
  const tableRight = tableX + 286;
  const rowY = (i: number) => 60 + i * 32;
  const rows = OVERVIEW_ROWS.map(
    ({ key, name, note }, i) =>
      text(tableX, rowY(i), name, { weight: "bold", fill: STRONG }) +
      text(tableX + 52, rowY(i), note, { size: SMALL }) +
      text(tableRight, rowY(i), `${EXAMPLE_TOTALS[key]} 分`, { anchor: "end", fill: STRONG }),
  ).join("");
  const total = Object.values(EXAMPLE_TOTALS).reduce((a, b) => a + b, 0);
  const radar = renderOverview({ totals: EXAMPLE_TOTALS, theme: THEME, palette: DEFAULT_SCHEME });
  const radarX = GUIDE_WIDTH - 310;
  const radarY = 10;
  const notesY = 250;
  return svg(
    "overview",
    text(tableX, 18, "例: ある期間の分の内訳", { weight: "bold", fill: STRONG }) +
      line(tableX, 34, tableRight, 34, MUTED) +
      rows +
      line(tableX, rowY(3) + 14, tableRight, rowY(3) + 14, MUTED) +
      text(tableX, rowY(3) + 34, "合計", { weight: "bold", fill: STRONG }) +
      text(tableRight, rowY(3) + 34, `${total} 分`, { anchor: "end", fill: STRONG }) +
      text(tableRight + 18, radarY + 116, "→", { anchor: "middle", size: 18, fill: STRONG }) +
      `<g data-part="radar" transform="translate(${radarX} ${radarY})">${radar}</g>` +
      line(20, notesY - 22, GUIDE_WIDTH - 20, notesY - 22, MUTED) +
      text(
        20,
        notesY,
        "・いちばん多い軸 (この例では 読む) が端まで届く。% は分の割合で、合計が 100",
        {
          size: SMALL,
        },
      ) +
      text(
        20,
        notesY + 20,
        "・少ない軸も見えるよう、長さは割合の平方根にしている (面積がおおむね割合に比例する)",
        {
          size: SMALL,
        },
      ),
  );
}

const RENDER: Record<GuideName, () => string> = {
  minutes: minutesSvg,
  grass: grassSvg,
  overview: overviewSvg,
};

/** 図の SVG。**知らない名前は `undefined`** (呼び出し側が 404 にする) */
export function renderGuide(name: string): string | undefined {
  return isGuideName(name) ? RENDER[name]() : undefined;
}
