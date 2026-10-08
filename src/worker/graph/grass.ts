/**
 * 図のレイアウト (design §8、ADR-0024 決定 3・ADR-0026)。`/v1/g/{publicId}/card.svg` を描く。
 * **寸法・色・ラベルの位置を決めるだけで、SVG の文字列は作らない** (文字列にするのは `grass-svg.ts`)。
 * 草の `layout.ts` / 概観の `overview.ts` と同じ分け方。
 *
 * **形 (期間 × マス) ごとの寸法は `GEOMETRIES` の表から引く** (ADR-0026 決定 2)。外寸は `src/shared/grass.ts` の `GRASS_SIZES`。
 * 段階 11 (#220) で草と概観もここへまとめる。
 *
 * - 草を上に、4 軸の線をその下に、名前の行を下端に置く (カードのサムネでは下が切れうるので、大事な絵を上に寄せる)
 * - マスは 1 日を朝・昼・夜の 3 マス (`slot`) か 1 マス (`day`)。期間は 26 週 (`half`) か 53 週 (`year`)
 * - **行は月曜始まり** (今の草は日曜始まり)。1 日は 朝 9–13 / 昼 13–18 / 夜 18–9 の 3 マスの縦長のタイル
 * - **夜は D の区間 3 と D+1 の区間 0 を足す** (その日の夜。design §4)。右端の日 (今日) の夜は D の区間 3 だけ
 * - **D の行が無くても、D+1 の区間 0 に分があれば D の夜に塗る** (#230)。計測開始日の前日でも塗る
 * - 区間が NULL の日 (内訳なし) は、その日の合計の色 (今の草と同じ色) を 3 マスに薄く塗る
 */
import { fromEpochDay, toEpochDay, weekdayOf } from "../../shared/epoch-day.ts";
import {
  CARD_FORM,
  type Cell,
  GRASS_SIZES,
  type GrassForm,
  SPAN_WEEKS,
  type Span,
} from "../../shared/grass.ts";
import type { Quad } from "../segments.ts";
import { type AxisDay, type AxisTotals, percentages, sumAxes } from "./axes.ts";
import { balanceOf, type Minutes } from "./balance.ts";
import { levelOf, type Scale } from "./scale.ts";
import { type SchemeName, schemeOf, type Theme } from "./scheme.ts";
import {
  FONT_FAMILY,
  layoutMark,
  MARK_CELL,
  MARK_RADIUS,
  MARK_SIZE,
  MUTED_COLOR,
  type Swatch,
} from "./style.ts";

export type Lang = "ja" | "en";
/** `write` はすべてのマスのバランスを 0 とみなす (Level は合計のまま。design §6) */
export type Mode = "bi" | "write";

/** その日の区間ごとの分 (`daily` の `sw0..sw3` / `sr0..sr3`)。 */
type CardSegments = {
  /** 書いた分 */
  readonly w: Quad;
  /** 読んだだけの分 (`r & ~w`) */
  readonly r: Quad;
};

/** `daily` の 1 日。**`segments` が無い日は内訳なし** (列を足す前の日。ADR-0024 決定 2)。 */
export type GrassDay = AxisDay & { readonly segments?: CardSegments };

export type GrassInput = {
  /** 実際の今日。**右端の日の夜に翌日を足すかどうかはこれで決める** (今日の夜は翌日の分がまだ無い) */
  readonly today: string;
  /** 右端の日。既定は `today`。`?year=` ならその年の 12/31 (今日より後なら今日) */
  readonly end?: string;
  /** 形。既定は `card.svg` の既定 (半年 × 3 分割) */
  readonly form?: GrassForm;
  readonly mode?: Mode;
  /** 記録のある最も古い日。これより前の日は塗らず点線の枠にする (Issue #80)。`ph = '*'` の全期間から取る */
  readonly startDay?: string;
  /** 表示範囲の日ごと。範囲外のキーがあっても無視する (夜の組み立てで翌日を引くのには使う) */
  readonly days: ReadonlyMap<string, GrassDay>;
  /** 時間帯のマスの四分位。`ph = '*'` の全期間の時間帯のマスの値から取る (`slotPopulation`) */
  readonly slotScale: Scale;
  readonly slotCenter: number;
  /** 日の合計の四分位とバランスの中心 (今の草と同じ。内訳なしの日の色に使う) */
  readonly dayScale: Scale;
  readonly dayCenter: number;
  readonly theme: Theme;
  readonly palette: SchemeName;
  readonly lang: Lang;
  /** 描くプロジェクト名 (`?l=`)。検証済みのものだけ。サーバは保存しない (ADR-0007) */
  readonly label?: string;
  /** 描くユーザー名 (`?u=`)。検証済みのものだけ。`<` `&` も通るので文字列にするときにエスケープする */
  readonly user?: string;
  /** アイコンの `data:` URI (`card-icon.ts`)。無ければユーザー名だけ */
  readonly icon?: string;
  /** 合算 (`ph = '*'`) か。プロジェクト名の代わりに合算の印を描き、アイコンは入れない */
  readonly total?: boolean;
};

/** 角の丸めの形。上のマスは上の角だけ、下のマスは下の角だけ、1 日 1 マスと点線の枠は四隅を丸める */
type CellShape = "top" | "middle" | "bottom" | "whole";

export type GrassCell = {
  readonly x: number;
  readonly y: number;
  readonly shape: CellShape;
  readonly fill: string;
  /** 内訳なしの日だけ薄くする */
  readonly opacity?: number;
  /** マスと違う高さ。計測開始前の点線の枠は 1 日のタイルの高さになる */
  readonly height?: number;
  /** 計測開始前の日の点線の枠の色。あれば塗らずに枠だけを描く */
  readonly outline?: string;
};

type GrassGridCell = GrassCell & {
  readonly day: string;
  /** 0 朝 / 1 昼 / 2 夜。1 日 1 マスと点線の枠は 0 */
  readonly slot: number;
  /** その時間帯の分。内訳なしの日は undefined */
  readonly minutes?: Minutes;
};

type GrassText = {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly anchor: "start" | "middle" | "end";
  readonly fill: string;
};

/** 4 軸の線の下の文字。軸名と % の両方か、% だけ */
type AxisName = {
  readonly x: number;
  readonly y: number;
  readonly name?: string;
  readonly percent: string;
};

type GrassLine = {
  readonly x1: number;
  readonly x2: number;
  readonly stroke: string;
};

/** 4 軸の線と、その下の軸名と % */
export type GrassAxis = {
  readonly y: number;
  readonly strokeWidth: number;
  /** 作る・育てる・関わる・読む のうち 0 でない軸の順。全部 0 なら淡い 1 本 */
  readonly lines: readonly GrassLine[];
  readonly names: readonly AxisName[];
  readonly nameSize: number;
  readonly letterSpacing: string;
  readonly nameColor: string;
  /** % の文字の大きさ・字間・色・不透明度 (よく見たら読める程度。ADR-0026 決定 5) */
  readonly percentSize: number;
  readonly percentSpacing: string;
  readonly percentColor: string;
  readonly percentOpacity: number;
  /** 軸名と % の間 */
  readonly percentGap: number;
};

export type GrassLayout = {
  readonly width: number;
  readonly height: number;
  readonly fontFamily: string;
  /** 月・曜日・「計」の大きさ */
  readonly fontSize: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly cellRadius: number;
  /** 月 → 曜日 → 「計」の見出しの順 */
  readonly labels: readonly GrassText[];
  /** 古い日から、1 日ごとに 朝・昼・夜 の順 (1 日 1 マスなら 1 日 1 つ) */
  readonly grid: readonly GrassGridCell[];
  /** 「計」の列。月曜の朝から日曜の夜の順 (1 日 1 マスなら月曜から日曜) */
  readonly sum: readonly GrassCell[];
  readonly axis: GrassAxis;
  readonly name: {
    readonly project?: GrassText & { readonly href: string; readonly size: number };
    readonly icon?: {
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly href: string;
    };
    readonly user?: GrassText & { readonly size: number };
    /** 合算の印 (奥から手前)。合算でなければ空 */
    readonly mark: readonly Swatch[];
    readonly markCellSize: number;
    readonly markCellRadius: number;
  };
};

// ---- 寸法 ----

const round = (n: number) => Math.round(n * 100) / 100;

const WEEKDAYS = 7;
/** 「計」の列と草の右端の間 */
const SUM_GAP = 8;

/**
 * 形 (期間 × マス) ごとに変わる寸法 (ADR-0026 決定 2)。**座標はその形の外寸の中の値。**
 * 形によらない寸法 (文字の大きさ・名前の行の部品など) は下の定数に置く
 */
type GeometrySpec = {
  readonly width: number;
  readonly height: number;
  /** 列 (週) の数 */
  readonly weeks: number;
  /** 1 日のマスの数。3 なら朝・昼・夜 */
  readonly slots: number;
  /** 草の左上 */
  readonly originX: number;
  readonly originY: number;
  /** マスの一辺 */
  readonly cell: number;
  /** 列の間 */
  readonly columnGap: number;
  /** 日と日の間 (縦) */
  readonly dayGap: number;
  /** 1 日のマスの切れ目 */
  readonly slotGap: number;
  readonly cellRadius: number;
  /** 4 軸の線の y */
  readonly axisY: number;
  /** 軸名のベースライン */
  readonly axisNameY: number;
  /** 名前の行のベースライン */
  readonly nameY: number;
};

/** 寸法の表の値から導く寸法も持たせたもの */
type Geometry = GeometrySpec & {
  readonly columnStep: number;
  /** 1 日のタイル (マスと切れ目) の高さ */
  readonly tileHeight: number;
  readonly rowStep: number;
  /** 草の右端 */
  readonly gridRight: number;
  /** 「計」の列の左端と右端 */
  readonly sumX: number;
  readonly sumRight: number;
  /** ユーザー名 (11.5px) の文字の縦中央。アイコンと合算の印をここにそろえる */
  readonly nameMiddle: number;
};

function geometryOf(spec: GeometrySpec): Geometry {
  const tileHeight = spec.slots * spec.cell + (spec.slots - 1) * spec.slotGap;
  const gridRight = spec.originX + spec.weeks * spec.cell + (spec.weeks - 1) * spec.columnGap;
  const sumX = gridRight + SUM_GAP;
  return {
    ...spec,
    columnStep: spec.cell + spec.columnGap,
    tileHeight,
    rowStep: tileHeight + spec.dayGap,
    gridRight,
    sumX,
    sumRight: sumX + spec.cell,
    nameMiddle: spec.nameY - 4,
  };
}

/** 半年 × 3 分割 (ADR-0024 決定 3 のカード)。500 × 400 の座標で、作者と合意したモックの値 */
const HALF_SLOT_COLUMN_GAP = 2.6;
const SLOT_GAP = 0.7;
/** 草の下端。マスの一辺は高さから決める: 21 マス + 日の間 6 + 切れ目 14 がここまでに収まる */
const HALF_SLOT_GRID_BOTTOM = 304;
const ORIGIN_Y = 40;
const HALF_SLOT_CELL =
  (HALF_SLOT_GRID_BOTTOM -
    ORIGIN_Y -
    (WEEKDAYS - 1) * HALF_SLOT_COLUMN_GAP -
    WEEKDAYS * (3 - 1) * SLOT_GAP) /
  (WEEKDAYS * 3);

const HALF_SLOT = geometryOf({
  ...GRASS_SIZES.half.slot,
  weeks: SPAN_WEEKS.half,
  slots: 3,
  originX: 56,
  originY: ORIGIN_Y,
  cell: HALF_SLOT_CELL,
  columnGap: HALF_SLOT_COLUMN_GAP,
  // 日と日の間は列の間と同じにして、縦横を均等に空ける
  dayGap: HALF_SLOT_COLUMN_GAP,
  slotGap: SLOT_GAP,
  cellRadius: 2.8,
  axisY: 324,
  axisNameY: 334,
  // 線から 38px 下げ、名前の行の下にも余白を取る (サムネで下が切れうる。ADR-0024 の帰結)
  nameY: 362,
});

// ほかの 3 つの形 (ADR-0026 決定 2。Issue #220 のモック)。**外寸の幅に、列と「計」の列が収まるようにマスを決める**
/** 曜日のラベルの余白を詰めた草の左端。英語の `Mon` が入る */
const FITTED_ORIGIN_X = 34;
const FITTED_RIGHT_PADDING = 12;
/** 列の間とマスの比。カードと同じ比にする */
const GAP_RATIO = HALF_SLOT_COLUMN_GAP / HALF_SLOT_CELL;
/** 草の下端から 4 軸の線まで */
const AXIS_OFFSET = 20;
/** 線から軸名のベースラインまで */
const AXIS_NAME_OFFSET = 10;
/** 線から名前の行のベースラインまで。カードより詰める (下が切れる心配が無い) */
const FITTED_NAME_OFFSET = 32;

function fittedGeometry(span: Span, cell: Cell, cellRadius: number): Geometry {
  const size = GRASS_SIZES[span][cell];
  const weeks = SPAN_WEEKS[span];
  const slots = cell === "slot" ? 3 : 1;
  const side =
    (size.width - FITTED_ORIGIN_X - FITTED_RIGHT_PADDING - SUM_GAP) /
    (weeks + 1 + (weeks - 1) * GAP_RATIO);
  const gap = side * GAP_RATIO;
  const tileHeight = slots * side + (slots - 1) * SLOT_GAP;
  const axisY = round(ORIGIN_Y + WEEKDAYS * tileHeight + (WEEKDAYS - 1) * gap + AXIS_OFFSET);
  return geometryOf({
    ...size,
    weeks,
    slots,
    originX: FITTED_ORIGIN_X,
    originY: ORIGIN_Y,
    cell: side,
    columnGap: gap,
    dayGap: gap,
    slotGap: SLOT_GAP,
    cellRadius,
    axisY,
    axisNameY: round(axisY + AXIS_NAME_OFFSET),
    nameY: round(axisY + FITTED_NAME_OFFSET),
  });
}

/** 形ごとの寸法の表 (ADR-0026 決定 2) */
const GEOMETRIES: Record<Span, Record<Cell, Geometry>> = {
  half: { slot: HALF_SLOT, day: fittedGeometry("half", "day", 3) },
  year: { slot: fittedGeometry("year", "slot", 2.6), day: fittedGeometry("year", "day", 2.6) },
};

/** 形の寸法。テストが外寸や名前の行の位置を確かめるのに使う */
export function geometryFor(form: GrassForm): Geometry {
  return GEOMETRIES[form.span][form.cell];
}

const FONT_SIZE = 10;
/** 月ラベルのベースライン (草の上端から) */
const MONTH_LABEL_OFFSET = 11;
/** 曜日ラベルの右端 (草の左端から) */
const WEEKDAY_LABEL_GAP = 10;
/** 10px の文字をタイルの縦中央に置くためのベースラインの補正 */
const WEEKDAY_BASELINE = 3.5;
/** 月ラベルが要る列数。「10月」「Oct」は 1 列 (約 14px) に収まらない */
const MONTH_LABEL_COLUMNS = 2;

/** 内訳なしの日の不透明度 */
const NO_BREAKDOWN_OPACITY = 0.35;

// 4 軸の線
const AXIS_STROKE = 3;
/** 区間の間 (見た目の隙間)。丸い端が線幅の半分はみ出すので、線はその分だけ内側に引く */
const AXIS_GAP = 3;
const AXIS_NAME_SIZE = 7.5;
const AXIS_LETTER_SPACING_EM = 0.25;
/** % は軸名より一段小さく淡く (よく見たら読める程度。ADR-0026 決定 5) */
const PERCENT_SIZE = 6.5;
const PERCENT_LETTER_SPACING_EM = 0.03;
const PERCENT_OPACITY = 0.8;
const PERCENT_GAP = 4;

// 名前の行
const PROJECT_SIZE = 15;
const USER_SIZE = 11.5;
const ICON_RADIUS = 8;
/** プロジェクト名とアイコン (かユーザー名) の間 */
const PROJECT_GAP = 10;
/** アイコンとユーザー名の間 */
const ICON_GAP = 5;
/** 合算の印とユーザー名の間 */
const MARK_GAP = 6;
const ELLIPSIS = "…";

/**
 * 文字幅の見積もり (em)。ASCII は Hiragino Sans の小文字・数字の平均より少し広め
 * (15px の `/cosense-grass` が約 0.56em。2026-10-07 に rsvg-convert で描いて測った)、
 * それ以外 (漢字・かな・絵文字) は全角とみなして少し余裕をみる。**名前が草の右端を超えないための見積もり**で、
 * 広めに取るとプロジェクト名とアイコンの間が空きすぎる
 */
const ASCII_EM = 0.58;
const WIDE_EM = 1.05;

// ---- 色 ----

/** 空きマスの灰色。朝 → 昼 → 夜 の順に少しずつ濃くする (時間帯の凡例の代わり) */
const EMPTY_FILL: Record<Theme, readonly [string, string, string]> = {
  light: ["#f6f8fa", "#eff1f4", "#e6e9ed"],
  dark: ["#161b22", "#1b2028", "#21262d"],
};
/** 1 日 1 マスの空きマス。時間帯が無いので、3 分割の真ん中 (昼) の灰色を使う */
const EMPTY_DAY_FILL: Record<Theme, string> = {
  light: EMPTY_FILL.light[1],
  dark: EMPTY_FILL.dark[1],
};

/** 文字色。濃 / 中 / 淡 / ごく淡 */
const STRONG: Record<Theme, string> = { light: "#24292f", dark: "#e6edf3" };
const MID: Record<Theme, string> = { light: "#8c959f", dark: "#7d8590" };
const FAINT: Record<Theme, string> = { light: "#afb8c1", dark: "#545d68" };
const FAINTEST: Record<Theme, string> = { light: "#c8cfd6", dark: "#424a53" };

/** 「計」の列の灰色 (rgb)。濃さは不透明度で表す */
const SUM_RGB: Record<Theme, string> = { light: "87,96,106", dark: "145,152,161" };
const SUM_ALPHA_MIN = 0.08;
const SUM_ALPHA_RANGE = 0.8;

/** 4 軸の線の色。作る・育てる・関わる・読む の順に濃 → 淡。ダークは濃淡を逆にする */
const AXIS_COLORS: Record<Theme, readonly [string, string, string, string]> = {
  light: ["#6e7781", "#959da6", "#b8c0c8", "#d8dde2"],
  dark: ["#9ea7b3", "#737c87", "#505861", "#363c44"],
};

// ---- 文言 ----

type Strings = {
  readonly weekdays: readonly string[];
  readonly months: readonly string[];
  readonly sum: string;
  /** 作る・育てる・関わる・読む の順 */
  readonly axes: readonly [string, string, string, string];
};

/** 英語は Worker のトップ (`site.ts`) の表記 (Create / Grow / Engage / Read) に合わせる */
const STRINGS: Record<Lang, Strings> = {
  ja: {
    weekdays: ["月", "火", "水", "木", "金", "土", "日"],
    months: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
    sum: "計",
    axes: ["作る", "育てる", "関わる", "読む"],
  },
  en: {
    weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    sum: "Sum",
    axes: ["Create", "Grow", "Engage", "Read"],
  },
};

const COSENSE_ORIGIN = "https://scrapbox.io";

// ---- 日付 ----

/** 月曜 = 0 .. 日曜 = 6 */
function mondayIndex(epochDay: number): number {
  return (weekdayOf(epochDay) + 6) % WEEKDAYS;
}

/** 表示範囲の最初の日 (今日の週の月曜から `weeks − 1` 週前の月曜)。左端の列は欠けない */
export function grassStart(today: string, weeks: number): string {
  const end = toEpochDay(today);
  return fromEpochDay(end - mondayIndex(end) - WEEKDAYS * (weeks - 1));
}

// ---- 時間帯 ----

/** 朝・昼・夜の分 */
export type Slots = readonly [Minutes, Minutes, Minutes];

/**
 * その日の 朝・昼・夜。**夜は D の区間 3 + D+1 の区間 0** (その日の夜)。
 *
 * - D の行があって内訳なしなら undefined (その日の合計で薄く塗る)
 * - **D の行が無くても、D+1 の区間 0 に分があれば 朝 0・昼 0・夜 = D+1 の区間 0** (#230)。分が無ければ undefined
 * - **D が `today` 以降なら翌日を足さない** (今日の夜は D の区間 3 だけ)。翌日の行が無いか内訳なしなら 0 を足す
 */
export function slotsOf(
  days: ReadonlyMap<string, GrassDay>,
  day: string,
  today: string,
): Slots | undefined {
  const next = day < today ? days.get(fromEpochDay(toEpochDay(day) + 1))?.segments : undefined;
  const current = days.get(day);
  if (current === undefined) {
    return next === undefined || next.w[0] + next.r[0] === 0
      ? undefined
      : [
          { w: 0, r: 0 },
          { w: 0, r: 0 },
          { w: next.w[0], r: next.r[0] },
        ];
  }
  const segments = current.segments;
  if (segments === undefined) {
    return undefined;
  }
  return [
    { w: segments.w[1], r: segments.r[1] },
    { w: segments.w[2], r: segments.r[2] },
    { w: segments.w[3] + (next?.w[0] ?? 0), r: segments.r[3] + (next?.r[0] ?? 0) },
  ];
}

/**
 * 時間帯のマスの四分位とバランスの中心を取る母集団。**内訳のある日の 朝・昼・夜 の値を全部並べる。**
 * 渡すのは `ph = '*'` の全期間 (今の草と同じく、プロジェクト別も共通のスケールで塗る。design §7)
 */
export function slotPopulation(days: ReadonlyMap<string, GrassDay>): Minutes[] {
  const result: Minutes[] = [];
  for (const day of days.keys()) {
    // 行の無い前日の夜 (その日の 0–9 時) も入れる (#230)
    const previous = fromEpochDay(toEpochDay(day) - 1);
    for (const d of days.has(previous) ? [day] : [previous, day]) {
      // 母集団では「今日」を区別しない。翌日の行があれば足す
      const slots = slotsOf(days, d, "9999-12-31");
      if (slots !== undefined) {
        result.push(...slots);
      }
    }
  }
  return result;
}

// ---- 文字幅 ----

const segmenter = new Intl.Segmenter();

function graphemes(text: string): string[] {
  return [...segmenter.segment(text)].map((s) => s.segment);
}

function charWidth(grapheme: string, size: number): number {
  return (/^[\x20-\x7e]$/.test(grapheme) ? ASCII_EM : WIDE_EM) * size;
}

/** 文字列の見積もり幅。`spacing` は 1 文字ごとに足す字間 */
export function estimateWidth(text: string, size: number, spacing = 0): number {
  return graphemes(text).reduce((sum, g) => sum + charWidth(g, size) + spacing, 0);
}

/**
 * 見積もり幅が `max` を超えるなら、書記素の単位で切って `…` を付ける。
 * `…` すら入らなければ undefined (描かない)
 */
function truncate(text: string, size: number, max: number): string | undefined {
  if (estimateWidth(text, size) <= max) {
    return text;
  }
  const ellipsis = charWidth(ELLIPSIS, size);
  let width = 0;
  let kept = "";
  for (const g of graphemes(text)) {
    const w = charWidth(g, size);
    if (width + w + ellipsis > max) {
      break;
    }
    width += w;
    kept += g;
  }
  return width + ellipsis <= max ? `${kept}${ELLIPSIS}` : undefined;
}

// ---- 各部 ----

function cellShape(g: Geometry, slot: number): CellShape {
  if (g.slots === 1) {
    return "whole";
  }
  return slot === 0 ? "top" : slot === g.slots - 1 ? "bottom" : "middle";
}

function cellY(g: Geometry, row: number, slot: number): number {
  return round(g.originY + row * g.rowStep + slot * (g.cell + g.slotGap));
}

/** 右端の日。既定は今日 */
const endOf = (input: GrassInput) => input.end ?? input.today;

function layoutGrid(
  input: GrassInput,
  g: Geometry,
): {
  readonly grid: GrassGridCell[];
  readonly sums: number[];
} {
  const scheme = schemeOf(input.palette);
  const { theme } = input;
  const write = input.mode === "write";
  // write は Level を合計のまま、バランスだけを 0 にする (design §6)
  const color = (minutes: Minutes, scale: Scale, center: number) => {
    const level = levelOf(minutes.w + minutes.r, scale);
    return level === 0
      ? undefined
      : scheme.cell({ level, balance: write ? 0 : balanceOf(minutes, center) }, theme);
  };
  const start = toEpochDay(grassStart(endOf(input), g.weeks));
  const end = toEpochDay(endOf(input));
  const sums = Array.from({ length: WEEKDAYS * g.slots }, () => 0);
  const grid: GrassGridCell[] = [];

  for (let epoch = start; epoch <= end; epoch++) {
    const day = fromEpochDay(epoch);
    const column = Math.floor((epoch - start) / WEEKDAYS);
    const row = mondayIndex(epoch);
    const x = round(g.originX + column * g.columnStep);
    const whole = input.days.get(day);
    // slotsOf は「実際の今日」で翌日を足すかを決める。`?year=` で過去の 12/31 が右端でも、その日の夜は翌日の区間 0 を足す
    const slots = g.slots === 1 ? undefined : slotsOf(input.days, day, input.today);

    // 計測開始前の日は塗らず、1 日のタイルに点線の枠を 1 つ描く (活動の無い日と区別する。Issue #80)。
    // 3 マスの形で夜に開始日の 0–9 時が入る前日は塗る (#230)
    if (input.startDay !== undefined && day < input.startDay && slots === undefined) {
      grid.push({
        x,
        y: cellY(g, row, 0),
        shape: "whole",
        fill: "none",
        height: round(g.tileHeight),
        outline: MUTED_COLOR[theme],
        day,
        slot: 0,
      });
      continue;
    }

    if (g.slots === 1) {
      const base = { x, y: cellY(g, row, 0), shape: cellShape(g, 0), day, slot: 0 };
      if (whole === undefined) {
        grid.push({ ...base, fill: EMPTY_DAY_FILL[theme] });
        continue;
      }
      sums[row] = (sums[row] ?? 0) + whole.w + whole.r;
      const minutes = { w: whole.w, r: whole.r };
      grid.push({
        ...base,
        fill: color(minutes, input.dayScale, input.dayCenter) ?? EMPTY_DAY_FILL[theme],
        minutes,
      });
      continue;
    }

    // 内訳なしの日は、今の草と同じ色 (日の合計) を 3 マスに薄く塗る
    const fallback =
      slots === undefined && whole !== undefined
        ? color(whole, input.dayScale, input.dayCenter)
        : undefined;

    for (let slot = 0; slot < g.slots; slot++) {
      const base = { x, y: cellY(g, row, slot), shape: cellShape(g, slot), day, slot };
      const minutes = slots?.[slot];
      if (minutes !== undefined) {
        sums[row * g.slots + slot] = (sums[row * g.slots + slot] ?? 0) + minutes.w + minutes.r;
        const fill =
          color(minutes, input.slotScale, input.slotCenter) ?? EMPTY_FILL[theme][slot] ?? "";
        grid.push({ ...base, fill, minutes });
      } else if (fallback !== undefined) {
        grid.push({ ...base, fill: fallback, opacity: NO_BREAKDOWN_OPACITY });
      } else {
        grid.push({ ...base, fill: EMPTY_FILL[theme][slot] ?? "" });
      }
    }
  }
  return { grid, sums };
}

function layoutSum(sums: readonly number[], theme: Theme, g: Geometry): GrassCell[] {
  const max = Math.max(...sums);
  return sums.map((value, i) => {
    const row = Math.floor(i / g.slots);
    const slot = i % g.slots;
    const alpha =
      Math.round((SUM_ALPHA_MIN + (max === 0 ? 0 : (SUM_ALPHA_RANGE * value) / max)) * 1000) / 1000;
    return {
      x: round(g.sumX),
      y: cellY(g, row, slot),
      shape: cellShape(g, slot),
      fill: `rgba(${SUM_RGB[theme]},${alpha})`,
    };
  });
}

function layoutLabels(input: GrassInput, strings: Strings, g: Geometry): GrassText[] {
  const { theme } = input;
  const start = toEpochDay(grassStart(endOf(input), g.weeks));
  const labels: GrassText[] = [];

  // 月ラベル: **その月の 1 日を含む列**に出す (2026-10-07、#208。月曜が 1〜7 日の列に限ると、1 日が火〜日の月は
  // 翌週の列にずれ、今月が右端の列だと出せなかった)。右端の日より後の 1 日には出さない。
  // ラベルは 2 列ぶんの幅が要る (`MONTH_LABEL_COLUMNS`) ので、右端の列では右端をそろえて「計」の見出しと重ねない
  const end = toEpochDay(endOf(input));
  for (let column = 0; column < g.weeks; column++) {
    const monday = start + column * WEEKDAYS;
    const first = Array.from({ length: WEEKDAYS }, (_, i) => monday + i).find(
      (day) => day <= end && fromEpochDay(day).endsWith("-01"),
    );
    if (first === undefined) {
      continue;
    }
    const tight = column > g.weeks - MONTH_LABEL_COLUMNS;
    labels.push({
      x: round(tight ? g.gridRight : g.originX + column * g.columnStep),
      y: g.originY - MONTH_LABEL_OFFSET,
      text: strings.months[Number(fromEpochDay(first).slice(5, 7)) - 1] ?? "",
      anchor: tight ? "end" : "start",
      fill: FAINT[theme],
    });
  }

  // 曜日: タイルの縦中央。土日は一段淡く
  strings.weekdays.forEach((text, row) => {
    labels.push({
      x: g.originX - WEEKDAY_LABEL_GAP,
      y: round(g.originY + row * g.rowStep + g.tileHeight / 2 + WEEKDAY_BASELINE),
      text,
      anchor: "end",
      fill: row >= 5 ? FAINT[theme] : MID[theme],
    });
  });

  labels.push({
    x: round(g.sumX + g.cell / 2),
    y: g.originY - MONTH_LABEL_OFFSET,
    text: strings.sum,
    anchor: "middle",
    fill: FAINT[theme],
  });
  return labels;
}

/**
 * 4 軸の線。草の左端から「計」の列の右端までを、0 でない軸で**全体に対する割合**で分ける。
 * 区間の左端の下に軸名と % を置く。見積もり幅が区間に収まらなければ % だけにし、それも入らなければ省く (ADR-0026 決定 5)
 */
function layoutAxis(input: GrassInput, g: Geometry): GrassAxis {
  const start = grassStart(endOf(input), g.weeks);
  const end = endOf(input);
  const inRange = [...input.days]
    .filter(([day]) => day >= start && day <= end)
    .map(([, values]) => values);
  return layoutAxisLine(sumAxes(inRange), {
    left: g.originX,
    right: g.sumRight,
    y: g.axisY,
    nameY: g.axisNameY,
    theme: input.theme,
    lang: input.lang,
  });
}

/**
 * 4 軸の値から、`left` から `right` までの線と軸名・% を置く。図の下の線 (`layoutAxis`) と説明の図 (`guide-svg.ts`) が使う
 */
export function layoutAxisLine(
  totals: AxisTotals,
  at: {
    readonly left: number;
    readonly right: number;
    readonly y: number;
    readonly nameY: number;
    readonly theme: Theme;
    readonly lang: Lang;
  },
): GrassAxis {
  const { theme } = at;
  const strings = STRINGS[at.lang];
  const values = [totals.create, totals.grow, totals.join, totals.read];
  // 端数が同じときは線の並び (作る・育てる・関わる・読む) の先を優先する
  const percents = percentages(values);
  const sum = values.reduce((a, b) => a + b, 0);
  const inset = AXIS_STROKE / 2;
  const percentSpacing = PERCENT_LETTER_SPACING_EM * PERCENT_SIZE;
  const base = {
    y: at.y,
    strokeWidth: AXIS_STROKE,
    nameSize: AXIS_NAME_SIZE,
    letterSpacing: `${AXIS_LETTER_SPACING_EM}em`,
    nameColor: FAINTEST[theme],
    percentSize: PERCENT_SIZE,
    percentSpacing: `${PERCENT_LETTER_SPACING_EM}em`,
    percentColor: FAINT[theme],
    percentOpacity: PERCENT_OPACITY,
    percentGap: PERCENT_GAP,
  };
  if (sum === 0) {
    return {
      ...base,
      lines: [{ x1: round(at.left + inset), x2: round(at.right - inset), stroke: FAINTEST[theme] }],
      names: [],
    };
  }

  const nonZero = values.flatMap((value, i) => (value > 0 ? [{ value, i }] : []));
  const available = at.right - at.left - AXIS_GAP * (nonZero.length - 1);
  const lines: GrassLine[] = [];
  const names: AxisName[] = [];
  let cursor = at.left;
  for (const { value, i } of nonZero) {
    const length = (available * value) / sum;
    // 丸い端が線幅の半分はみ出すので、見た目の区間 [cursor, cursor + length] に収まるよう内側に引く。
    // 線幅より短い区間は点にする
    const [x1, x2] =
      length > AXIS_STROKE
        ? [cursor + inset, cursor + length - inset]
        : [cursor + length / 2, cursor + length / 2];
    lines.push({ x1: round(x1), x2: round(x2), stroke: AXIS_COLORS[theme][i] ?? "" });
    const name = strings.axes[i] ?? "";
    const percent = `${percents[i] ?? 0}%`;
    const nameWidth = estimateWidth(name, AXIS_NAME_SIZE, AXIS_LETTER_SPACING_EM * AXIS_NAME_SIZE);
    const percentWidth = estimateWidth(percent, PERCENT_SIZE, percentSpacing);
    const position = { x: round(cursor), y: at.nameY };
    if (nameWidth + PERCENT_GAP + percentWidth <= length) {
      names.push({ ...position, name, percent });
    } else if (percentWidth <= length) {
      names.push({ ...position, percent });
    }
    cursor += length + AXIS_GAP;
  }
  return { ...base, lines, names };
}

/**
 * 名前の行。`/プロジェクト名` (太字・リンク)、アイコン (丸く切り抜く)、ユーザー名 (控えめ、`@` なし) の順。
 * 合算は合算の印とユーザー名だけ。**草の右端を超えないよう、見積もり幅で切って `…` を付ける**
 */
function layoutName(input: GrassInput, g: Geometry): GrassLayout["name"] {
  const { theme } = input;
  const scheme = schemeOf(input.palette);
  const total = input.total === true;
  const mark = total
    ? layoutMark(scheme, theme, g.originX, g.nameMiddle - MARK_SIZE / 2).map((s) => ({
        ...s,
        y: round(s.y),
      }))
    : [];
  const common = { mark, markCellSize: MARK_CELL, markCellRadius: MARK_RADIUS };

  const icon = total ? undefined : input.icon;
  const project = total ? undefined : input.label;
  const left = total ? g.originX + MARK_SIZE + MARK_GAP : g.originX;
  const available = g.gridRight - left;
  const iconBlock = icon === undefined ? 0 : ICON_RADIUS * 2 + ICON_GAP;

  const projectText = project === undefined ? undefined : `/${project}`;
  const projectFull = projectText === undefined ? 0 : estimateWidth(projectText, PROJECT_SIZE);
  const userFull = input.user === undefined ? 0 : iconBlock + estimateWidth(input.user, USER_SIZE);
  const between = projectText !== undefined && input.user !== undefined ? PROJECT_GAP : 0;

  // 収まらなければ、ユーザー名に少なくとも 4 割を残してプロジェクト名から切る
  let projectShown = projectText;
  if (projectText !== undefined && projectFull + between + userFull > available) {
    const projectMax =
      input.user === undefined
        ? available
        : Math.max(available - between - userFull, available * 0.6);
    projectShown = truncate(projectText, PROJECT_SIZE, projectMax);
  }
  const projectWidth = projectShown === undefined ? 0 : estimateWidth(projectShown, PROJECT_SIZE);

  const result: {
    project?: GrassText & { href: string; size: number };
    icon?: { cx: number; cy: number; r: number; href: string };
    user?: GrassText & { size: number };
  } = {};
  if (projectShown !== undefined && project !== undefined) {
    result.project = {
      x: left,
      y: g.nameY,
      text: projectShown,
      anchor: "start",
      fill: STRONG[theme],
      href: `${COSENSE_ORIGIN}/${encodeURIComponent(project)}/`,
      size: PROJECT_SIZE,
    };
  }
  if (input.user !== undefined) {
    let x = left + projectWidth + (projectShown === undefined ? 0 : PROJECT_GAP);
    const userShown = truncate(input.user, USER_SIZE, g.gridRight - x - iconBlock);
    if (userShown !== undefined) {
      if (icon !== undefined) {
        result.icon = { cx: round(x + ICON_RADIUS), cy: g.nameMiddle, r: ICON_RADIUS, href: icon };
        x += iconBlock;
      }
      result.user = {
        x: round(x),
        y: g.nameY,
        text: userShown,
        anchor: "start",
        fill: MID[theme],
        size: USER_SIZE,
      };
    }
  }
  return { ...common, ...result };
}

export function layoutGrass(input: GrassInput): GrassLayout {
  const g = geometryFor(input.form ?? CARD_FORM);
  const strings = STRINGS[input.lang];
  const { grid, sums } = layoutGrid(input, g);
  return {
    // width / height / viewBox の 3 つを必ず出す。欠けると Cosense でサイズが崩れる (design §8)
    width: g.width,
    height: g.height,
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    cellWidth: round(g.cell),
    cellHeight: round(g.cell),
    cellRadius: g.cellRadius,
    labels: layoutLabels(input, strings, g),
    grid,
    sum: layoutSum(sums, input.theme, g),
    axis: layoutAxis(input, g),
    name: layoutName(input, g),
  };
}
