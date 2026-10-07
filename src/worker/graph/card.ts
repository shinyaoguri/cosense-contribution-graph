/**
 * カードの図 (`/v1/g/{publicId}/card.svg`) のレイアウト (design §8、ADR-0024 決定 3)。
 * **寸法・色・ラベルの位置を決めるだけで、SVG の文字列は作らない** (文字列にするのは `card-svg.ts`)。
 * 草の `layout.ts` / 概観の `overview.ts` と同じ分け方。
 *
 * - 500 × 400。草 (曜日 × 時間帯の 21 行 × 26 週) を上に、4 軸の線をその下に、名前の行を下端に置く
 *   (カードのサムネでは下が切れうるので、大事な絵を上に寄せる)
 * - **行は月曜始まり** (今の草は日曜始まり)。1 日は 朝 9–13 / 昼 13–18 / 夜 18–9 の 3 マスの縦長のタイル
 * - **夜は D の区間 3 と D+1 の区間 0 を足す** (その日の夜。design §4)。右端の日 (今日) の夜は D の区間 3 だけ
 * - 区間が NULL の日 (内訳なし) は、その日の合計の色 (今の草と同じ色) を 3 マスに薄く塗る
 */
import { fromEpochDay, toEpochDay, weekdayOf } from "../../shared/epoch-day.ts";
import type { Quad } from "../segments.ts";
import { balanceOf, type Minutes } from "./balance.ts";
import {
  FONT_FAMILY,
  layoutMark,
  MARK_CELL,
  MARK_RADIUS,
  MARK_SIZE,
  type Swatch,
} from "./layout.ts";
import { type OverviewDay, sumOverview } from "./overview.ts";
import { levelOf, type Scale } from "./scale.ts";
import { type SchemeName, schemeOf, type Theme } from "./scheme.ts";

/** 表示する週数。**クエリでは変えない** (寸法を固定してカードの見え方をそろえる。ADR-0024 決定 4) */
export const CARD_WEEKS = 26;

export type Lang = "ja" | "en";

/** その日の区間ごとの分 (`daily` の `sw0..sw3` / `sr0..sr3`)。 */
type CardSegments = {
  /** 書いた分 */
  readonly w: Quad;
  /** 読んだだけの分 (`r & ~w`) */
  readonly r: Quad;
};

/** `daily` の 1 日。**`segments` が無い日は内訳なし** (列を足す前の日。ADR-0024 決定 2)。 */
export type CardDay = OverviewDay & { readonly segments?: CardSegments };

export type CardInput = {
  /** 右端の日 (今日) */
  readonly today: string;
  /** 表示範囲の日ごと。範囲外のキーがあっても無視する (夜の組み立てで翌日を引くのには使う) */
  readonly days: ReadonlyMap<string, CardDay>;
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

export type CardCell = {
  readonly x: number;
  readonly y: number;
  readonly shape: CellShape;
  readonly fill: string;
  /** 内訳なしの日だけ薄くする */
  readonly opacity?: number;
};

type CardGridCell = CardCell & {
  readonly day: string;
  /** 0 朝 / 1 昼 / 2 夜 */
  readonly slot: number;
  /** その時間帯の分。内訳なしの日は undefined */
  readonly minutes?: Minutes;
};

type CardText = {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly anchor: "start" | "middle" | "end";
  readonly fill: string;
};

type CardLine = {
  readonly x1: number;
  readonly x2: number;
  readonly stroke: string;
};

export type CardLayout = {
  readonly width: number;
  readonly height: number;
  readonly fontFamily: string;
  /** 月・曜日・「計」の大きさ */
  readonly fontSize: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly cellRadius: number;
  /** 月 → 曜日 → 「計」の見出しの順 */
  readonly labels: readonly CardText[];
  /** 古い日から、1 日ごとに 朝・昼・夜 の順 */
  readonly grid: readonly CardGridCell[];
  /** 「計」の列。月曜の朝から日曜の夜の順 */
  readonly sum: readonly CardCell[];
  readonly axis: {
    readonly y: number;
    readonly strokeWidth: number;
    /** 作る・育てる・関わる・読む のうち 0 でない軸の順。全部 0 なら淡い 1 本 */
    readonly lines: readonly CardLine[];
    readonly names: readonly CardText[];
    readonly nameSize: number;
    readonly letterSpacing: string;
    readonly nameColor: string;
  };
  readonly name: {
    readonly project?: CardText & { readonly href: string; readonly size: number };
    readonly icon?: {
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly href: string;
    };
    readonly user?: CardText & { readonly size: number };
    /** 合算の印 (奥から手前)。合算でなければ空 */
    readonly mark: readonly Swatch[];
    readonly markCellSize: number;
    readonly markCellRadius: number;
  };
};

// ---- 寸法 (500 × 400 の座標。作者と合意したモックの値) ----

const WIDTH = 500;
const HEIGHT = 400;
/** 草の左上 */
const ORIGIN_X = 56;
const ORIGIN_Y = 40;
/** 草の下端 */
const GRID_BOTTOM = 304;
/** 列の間 */
const COLUMN_GAP = 2.6;
/** 日と日の間 (縦)。列の間と同じにして、縦横を均等に空ける */
const DAY_GAP = COLUMN_GAP;
/** 1 日の 3 マスの切れ目 */
const SLOT_GAP = 0.7;
const SLOTS = 3;
const WEEKDAYS = 7;
/** マスの一辺は高さから決める: 21 マス + 日の間 6 + 切れ目 14 が草の高さに収まる */
const CELL =
  (GRID_BOTTOM - ORIGIN_Y - (WEEKDAYS - 1) * DAY_GAP - WEEKDAYS * (SLOTS - 1) * SLOT_GAP) /
  (WEEKDAYS * SLOTS);
const COLUMN_STEP = CELL + COLUMN_GAP;
const TILE_HEIGHT = SLOTS * CELL + (SLOTS - 1) * SLOT_GAP;
const ROW_STEP = TILE_HEIGHT + DAY_GAP;
const CELL_RADIUS = 2.8;
const GRID_RIGHT = ORIGIN_X + CARD_WEEKS * CELL + (CARD_WEEKS - 1) * COLUMN_GAP;
/** 「計」の列 */
const SUM_X = GRID_RIGHT + 8;
const SUM_RIGHT = SUM_X + CELL;

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
const AXIS_Y = 324;
const AXIS_STROKE = 3;
/** 区間の間 (見た目の隙間)。丸い端が線幅の半分はみ出すので、線はその分だけ内側に引く */
const AXIS_GAP = 3;
const AXIS_NAME_Y = 334;
const AXIS_NAME_SIZE = 7.5;
const AXIS_LETTER_SPACING_EM = 0.25;

// 名前の行
const NAME_Y = 362;
const PROJECT_SIZE = 15;
const USER_SIZE = 11.5;
const ICON_RADIUS = 8;
/** プロジェクト名とアイコン (かユーザー名) の間 */
const PROJECT_GAP = 10;
/** アイコンとユーザー名の間 */
const ICON_GAP = 5;
/** 合算の印とユーザー名の間 */
const MARK_GAP = 6;
/** ユーザー名 (11.5px) の文字の縦中央。アイコンと合算の印をここにそろえる */
const NAME_MIDDLE = NAME_Y - 4;
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

/** 表示範囲の最初の日 (今日の週の月曜から 25 週前の月曜)。左端の列は欠けない */
export function cardStart(today: string): string {
  const end = toEpochDay(today);
  return fromEpochDay(end - mondayIndex(end) - WEEKDAYS * (CARD_WEEKS - 1));
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
  days: ReadonlyMap<string, CardDay>,
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
export function slotPopulation(days: ReadonlyMap<string, CardDay>): Minutes[] {
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

function cellShape(slot: number): CellShape {
  return slot === 0 ? "top" : slot === SLOTS - 1 ? "bottom" : "middle";
}

function cellY(row: number, slot: number): number {
  return round(ORIGIN_Y + row * ROW_STEP + slot * (CELL + SLOT_GAP));
}

function layoutGrid(input: CardInput): {
  readonly grid: CardGridCell[];
  readonly sums: number[];
} {
  const scheme = schemeOf(input.palette);
  const { theme } = input;
  const start = toEpochDay(cardStart(input.today));
  const end = toEpochDay(input.today);
  const sums = Array.from({ length: WEEKDAYS * SLOTS }, () => 0);
  const grid: CardGridCell[] = [];

  for (let epoch = start; epoch <= end; epoch++) {
    const day = fromEpochDay(epoch);
    const column = Math.floor((epoch - start) / WEEKDAYS);
    const row = mondayIndex(epoch);
    const x = round(ORIGIN_X + column * COLUMN_STEP);
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

    for (let slot = 0; slot < SLOTS; slot++) {
      const base = { x, y: cellY(row, slot), shape: cellShape(slot), day, slot };
      const minutes = slots?.[slot];
      if (minutes !== undefined) {
        sums[row * SLOTS + slot] = (sums[row * SLOTS + slot] ?? 0) + minutes.w + minutes.r;
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

function layoutSum(sums: readonly number[], theme: Theme): CardCell[] {
  const max = Math.max(...sums);
  return sums.map((value, i) => {
    const row = Math.floor(i / SLOTS);
    const slot = i % SLOTS;
    const alpha =
      Math.round((SUM_ALPHA_MIN + (max === 0 ? 0 : (SUM_ALPHA_RANGE * value) / max)) * 1000) / 1000;
    return {
      x: round(SUM_X),
      y: cellY(row, slot),
      shape: cellShape(slot),
      fill: `rgba(${SUM_RGB[theme]},${alpha})`,
    };
  });
}

function layoutLabels(input: CardInput, strings: Strings): CardText[] {
  const { theme } = input;
  const start = toEpochDay(cardStart(input.today));
  const labels: CardText[] = [];

  // 月ラベル: 月の 1〜7 日が月曜の列 (その月の最初の週) にだけ出す。右端の 1 列には入らないので出さない
  for (let column = 0; column <= CARD_WEEKS - MONTH_LABEL_COLUMNS; column++) {
    const monday = fromEpochDay(start + column * WEEKDAYS);
    if (Number(monday.slice(8, 10)) > WEEKDAYS) {
      continue;
    }
    labels.push({
      x: round(ORIGIN_X + column * COLUMN_STEP),
      y: ORIGIN_Y - MONTH_LABEL_OFFSET,
      text: strings.months[Number(monday.slice(5, 7)) - 1] ?? "",
      anchor: "start",
      fill: FAINT[theme],
    });
  }

  // 曜日: タイルの縦中央。土日は一段淡く
  strings.weekdays.forEach((text, row) => {
    labels.push({
      x: ORIGIN_X - WEEKDAY_LABEL_GAP,
      y: round(ORIGIN_Y + row * ROW_STEP + TILE_HEIGHT / 2 + WEEKDAY_BASELINE),
      text,
      anchor: "end",
      fill: row >= 5 ? FAINT[theme] : MID[theme],
    });
  });

  labels.push({
    x: round(SUM_X + CELL / 2),
    y: ORIGIN_Y - MONTH_LABEL_OFFSET,
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
function layoutAxis(input: CardInput, strings: Strings): CardLayout["axis"] {
  const { theme } = input;
  const start = cardStart(input.today);
  const inRange = [...input.days]
    .filter(([day]) => day >= start && day <= input.today)
    .map(([, values]) => values);
  const totals = sumOverview(inRange);
  const values = [totals.create, totals.grow, totals.join, totals.read];
  const sum = values.reduce((a, b) => a + b, 0);
  const inset = AXIS_STROKE / 2;
  const base = {
    y: AXIS_Y,
    strokeWidth: AXIS_STROKE,
    nameSize: AXIS_NAME_SIZE,
    letterSpacing: `${AXIS_LETTER_SPACING_EM}em`,
    nameColor: FAINTEST[theme],
  };
  if (sum === 0) {
    return {
      ...base,
      lines: [
        { x1: round(ORIGIN_X + inset), x2: round(SUM_RIGHT - inset), stroke: FAINTEST[theme] },
      ],
      names: [],
    };
  }

  const nonZero = values.flatMap((value, i) => (value > 0 ? [{ value, i }] : []));
  const available = SUM_RIGHT - ORIGIN_X - AXIS_GAP * (nonZero.length - 1);
  const lines: CardLine[] = [];
  const names: CardText[] = [];
  let cursor = ORIGIN_X;
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
        y: AXIS_NAME_Y,
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
function layoutName(input: CardInput): CardLayout["name"] {
  const { theme } = input;
  const scheme = schemeOf(input.palette);
  const total = input.total === true;
  const mark = total
    ? layoutMark(scheme, theme, ORIGIN_X, NAME_MIDDLE - MARK_SIZE / 2).map((s) => ({
        ...s,
        y: round(s.y),
      }))
    : [];
  const common = { mark, markCellSize: MARK_CELL, markCellRadius: MARK_RADIUS };

  const icon = total ? undefined : input.icon;
  const project = total ? undefined : input.label;
  const left = total ? ORIGIN_X + MARK_SIZE + MARK_GAP : ORIGIN_X;
  const available = GRID_RIGHT - left;
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
    project?: CardText & { href: string; size: number };
    icon?: { cx: number; cy: number; r: number; href: string };
    user?: CardText & { size: number };
  } = {};
  if (projectShown !== undefined && project !== undefined) {
    result.project = {
      x: left,
      y: NAME_Y,
      text: projectShown,
      anchor: "start",
      fill: STRONG[theme],
      href: `${COSENSE_ORIGIN}/${encodeURIComponent(project)}/`,
      size: PROJECT_SIZE,
    };
  }
  if (input.user !== undefined) {
    let x = left + projectWidth + (projectShown === undefined ? 0 : PROJECT_GAP);
    const userShown = truncate(input.user, USER_SIZE, GRID_RIGHT - x - iconBlock);
    if (userShown !== undefined) {
      if (icon !== undefined) {
        result.icon = { cx: round(x + ICON_RADIUS), cy: NAME_MIDDLE, r: ICON_RADIUS, href: icon };
        x += iconBlock;
      }
      result.user = {
        x: round(x),
        y: NAME_Y,
        text: userShown,
        anchor: "start",
        fill: MID[theme],
        size: USER_SIZE,
      };
    }
  }
  return { ...common, ...result };
}

export function layoutCard(input: CardInput): CardLayout {
  const strings = STRINGS[input.lang];
  const { grid, sums } = layoutGrid(input);
  return {
    // width / height / viewBox の 3 つを必ず出す。欠けると Cosense でサイズが崩れる (design §8)
    width: WIDTH,
    height: HEIGHT,
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    cellWidth: round(CELL),
    cellHeight: round(CELL),
    cellRadius: CELL_RADIUS,
    labels: layoutLabels(input, strings),
    grid,
    sum: layoutSum(sums, input.theme),
    axis: layoutAxis(input, strings),
    name: layoutName(input),
  };
}
