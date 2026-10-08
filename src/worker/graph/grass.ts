/**
 * 図のレイアウト (design §8、ADR-0024 決定 3・ADR-0026)。今は `/v1/g/{publicId}/card.svg` のカードを描く。
 * **寸法・色・ラベルの位置を決めるだけで、SVG の文字列は作らない** (文字列にするのは `grass-svg.ts`)。
 * 草の `layout.ts` / 概観の `overview.ts` と同じ分け方。
 *
 * **形 (期間 × マス) ごとの寸法は `GEOMETRIES` の表から引く** (ADR-0026 決定 2)。段階 11 (#220) で草と概観をここへまとめ、
 * 表に 4 つの形を並べる。今は半年 × 3 分割だけ。
 *
 * - 500 × 400。草 (曜日 × 時間帯の 21 行 × 26 週) を上に、4 軸の線をその下に、名前の行を下端に置く
 *   (カードのサムネでは下が切れうるので、大事な絵を上に寄せる)
 * - **行は月曜始まり** (今の草は日曜始まり)。1 日は 朝 9–13 / 昼 13–18 / 夜 18–9 の 3 マスの縦長のタイル
 * - **夜は D の区間 3 と D+1 の区間 0 を足す** (その日の夜。design §4)。右端の日 (今日) の夜は D の区間 3 だけ
 * - 区間が NULL の日 (内訳なし) は、その日の合計の色 (今の草と同じ色) を 3 マスに薄く塗る
 */
import { fromEpochDay, toEpochDay, weekdayOf } from "../../shared/epoch-day.ts";
import type { Quad } from "../segments.ts";
import { type AxisDay, sumAxes } from "./axes.ts";
import { balanceOf, type Minutes } from "./balance.ts";
import { levelOf, type Scale } from "./scale.ts";
import { type SchemeName, schemeOf, type Theme } from "./scheme.ts";
import {
  FONT_FAMILY,
  layoutMark,
  MARK_CELL,
  MARK_RADIUS,
  MARK_SIZE,
  type Swatch,
} from "./style.ts";

/** 半年の週数 (ADR-0024 決定 3)。1 年 (53 週) は段階 11 で足す (ADR-0026) */
export const HALF_WEEKS = 26;

export type Lang = "ja" | "en";

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
  /** 右端の日 (今日) */
  readonly today: string;
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

/** 角の丸めの形。上のマスは上の角だけ、下のマスは下の角だけ丸める */
type CellShape = "top" | "middle" | "bottom";

export type GrassCell = {
  readonly x: number;
  readonly y: number;
  readonly shape: CellShape;
  readonly fill: string;
  /** 内訳なしの日だけ薄くする */
  readonly opacity?: number;
};

type GrassGridCell = GrassCell & {
  readonly day: string;
  /** 0 朝 / 1 昼 / 2 夜 */
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

type GrassLine = {
  readonly x1: number;
  readonly x2: number;
  readonly stroke: string;
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
  /** 古い日から、1 日ごとに 朝・昼・夜 の順 */
  readonly grid: readonly GrassGridCell[];
  /** 「計」の列。月曜の朝から日曜の夜の順 */
  readonly sum: readonly GrassCell[];
  readonly axis: {
    readonly y: number;
    readonly strokeWidth: number;
    /** 作る・育てる・関わる・読む のうち 0 でない軸の順。全部 0 なら淡い 1 本 */
    readonly lines: readonly GrassLine[];
    readonly names: readonly GrassText[];
    readonly nameSize: number;
    readonly letterSpacing: string;
    readonly nameColor: string;
  };
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
const HALF_SLOT_SLOT_GAP = 0.7;
/** 草の下端。マスの一辺は高さから決める: 21 マス + 日の間 6 + 切れ目 14 がここまでに収まる */
const HALF_SLOT_GRID_BOTTOM = 304;
const HALF_SLOT_ORIGIN_Y = 40;

/**
 * 形ごとの寸法の表 (ADR-0026 決定 2)。**今は半年 × 3 分割だけ**で、ほかの 3 つの形は段階 11 (#220) で足す
 */
const GEOMETRIES = {
  "half-slot": geometryOf({
    width: 500,
    height: 400,
    weeks: HALF_WEEKS,
    slots: 3,
    originX: 56,
    originY: HALF_SLOT_ORIGIN_Y,
    cell:
      (HALF_SLOT_GRID_BOTTOM -
        HALF_SLOT_ORIGIN_Y -
        (WEEKDAYS - 1) * HALF_SLOT_COLUMN_GAP -
        WEEKDAYS * (3 - 1) * HALF_SLOT_SLOT_GAP) /
      (WEEKDAYS * 3),
    columnGap: HALF_SLOT_COLUMN_GAP,
    // 日と日の間は列の間と同じにして、縦横を均等に空ける
    dayGap: HALF_SLOT_COLUMN_GAP,
    slotGap: HALF_SLOT_SLOT_GAP,
    cellRadius: 2.8,
    axisY: 324,
    axisNameY: 334,
    nameY: 362,
  }),
} as const satisfies Record<string, Geometry>;

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
 * - D に内訳が無ければ undefined (内訳なし)
 * - **D が `today` 以降なら翌日を足さない** (今日の夜は D の区間 3 だけ)。翌日の行が無いか内訳なしなら 0 を足す
 */
export function slotsOf(
  days: ReadonlyMap<string, GrassDay>,
  day: string,
  today: string,
): Slots | undefined {
  const segments = days.get(day)?.segments;
  if (segments === undefined) {
    return undefined;
  }
  const next = day < today ? days.get(fromEpochDay(toEpochDay(day) + 1))?.segments : undefined;
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
    // 母集団では「今日」を区別しない。翌日の行があれば足す
    const slots = slotsOf(days, day, "9999-12-31");
    if (slots !== undefined) {
      result.push(...slots);
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

const round = (n: number) => Math.round(n * 100) / 100;

// ---- 各部 ----

function cellShape(g: Geometry, slot: number): CellShape {
  return slot === 0 ? "top" : slot === g.slots - 1 ? "bottom" : "middle";
}

function cellY(g: Geometry, row: number, slot: number): number {
  return round(g.originY + row * g.rowStep + slot * (g.cell + g.slotGap));
}

function layoutGrid(
  input: GrassInput,
  g: Geometry,
): {
  readonly grid: GrassGridCell[];
  readonly sums: number[];
} {
  const scheme = schemeOf(input.palette);
  const { theme } = input;
  const start = toEpochDay(grassStart(input.today, g.weeks));
  const end = toEpochDay(input.today);
  const sums = Array.from({ length: WEEKDAYS * g.slots }, () => 0);
  const grid: GrassGridCell[] = [];

  for (let epoch = start; epoch <= end; epoch++) {
    const day = fromEpochDay(epoch);
    const column = Math.floor((epoch - start) / WEEKDAYS);
    const row = mondayIndex(epoch);
    const x = round(g.originX + column * g.columnStep);
    const slots = slotsOf(input.days, day, input.today);
    const whole = input.days.get(day);
    // 内訳なしの日は、今の草と同じ色 (日の合計) を 3 マスに薄く塗る
    const fallback =
      slots === undefined && whole !== undefined
        ? (() => {
            const level = levelOf(whole.w + whole.r, input.dayScale);
            return level === 0
              ? undefined
              : scheme.cell({ level, balance: balanceOf(whole, input.dayCenter) }, theme);
          })()
        : undefined;

    for (let slot = 0; slot < g.slots; slot++) {
      const base = { x, y: cellY(g, row, slot), shape: cellShape(g, slot), day, slot };
      const minutes = slots?.[slot];
      if (minutes !== undefined) {
        sums[row * g.slots + slot] = (sums[row * g.slots + slot] ?? 0) + minutes.w + minutes.r;
        const level = levelOf(minutes.w + minutes.r, input.slotScale);
        const fill =
          level === 0
            ? (EMPTY_FILL[theme][slot] ?? "")
            : scheme.cell({ level, balance: balanceOf(minutes, input.slotCenter) }, theme);
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
  const start = toEpochDay(grassStart(input.today, g.weeks));
  const labels: GrassText[] = [];

  // 月ラベル: **その月の 1 日を含む列**に出す (2026-10-07、#208。月曜が 1〜7 日の列に限ると、1 日が火〜日の月は
  // 翌週の列にずれ、今月が右端の列だと出せなかった)。まだ来ていない 1 日には出さない。
  // ラベルは 2 列ぶんの幅が要る (`MONTH_LABEL_COLUMNS`) ので、右端の列では右端をそろえて「計」の見出しと重ねない
  const today = toEpochDay(input.today);
  for (let column = 0; column < g.weeks; column++) {
    const monday = start + column * WEEKDAYS;
    const first = Array.from({ length: WEEKDAYS }, (_, i) => monday + i).find(
      (day) => day <= today && fromEpochDay(day).endsWith("-01"),
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
 * 名前は区間の左端の下に置き、見積もり幅が区間に収まらなければ省く
 */
function layoutAxis(input: GrassInput, strings: Strings, g: Geometry): GrassLayout["axis"] {
  const { theme } = input;
  const start = grassStart(input.today, g.weeks);
  const inRange = [...input.days]
    .filter(([day]) => day >= start && day <= input.today)
    .map(([, values]) => values);
  const totals = sumAxes(inRange);
  const values = [totals.create, totals.grow, totals.join, totals.read];
  const sum = values.reduce((a, b) => a + b, 0);
  const inset = AXIS_STROKE / 2;
  const base = {
    y: g.axisY,
    strokeWidth: AXIS_STROKE,
    nameSize: AXIS_NAME_SIZE,
    letterSpacing: `${AXIS_LETTER_SPACING_EM}em`,
    nameColor: FAINTEST[theme],
  };
  if (sum === 0) {
    return {
      ...base,
      lines: [
        { x1: round(g.originX + inset), x2: round(g.sumRight - inset), stroke: FAINTEST[theme] },
      ],
      names: [],
    };
  }

  const nonZero = values.flatMap((value, i) => (value > 0 ? [{ value, i }] : []));
  const available = g.sumRight - g.originX - AXIS_GAP * (nonZero.length - 1);
  const lines: GrassLine[] = [];
  const names: GrassText[] = [];
  let cursor = g.originX;
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
    const spacing = AXIS_LETTER_SPACING_EM * AXIS_NAME_SIZE;
    if (estimateWidth(name, AXIS_NAME_SIZE, spacing) <= length) {
      names.push({
        x: round(cursor),
        y: g.axisNameY,
        text: name,
        anchor: "start",
        fill: FAINTEST[theme],
      });
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
  const g = GEOMETRIES["half-slot"];
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
    axis: layoutAxis(input, strings, g),
    name: layoutName(input, g),
  };
}
