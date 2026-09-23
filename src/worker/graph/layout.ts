/**
 * 草のレイアウト (design §8)。**寸法・色・ラベルの位置を決めるだけで、SVG の文字列も DOM も作らない。**
 *
 * 読むのは `src/worker/svg.ts` だけで、これを `<img>` で読まれる SVG の文字列にする。
 * **草を描くのは Worker だけ** (ADR-0019)。1.0.0 までは UserScript も同じレイアウトから DOM の SVG を
 * 組み立てていたので `src/shared/` に置いていた。
 *
 * **色はスキームに任せる** (`./scheme.ts`)。ここはバランスを計算してスキームに渡すだけで、
 * どの色相になるかを知らない。凡例もスキームの `legendBalances` から組み立てる。
 */

import { balanceOf, type Minutes } from "./balance.ts";
import {
  CELL,
  DAYS,
  GAP,
  type GridCell,
  gridCells,
  monthLabels,
  type Params,
  STEP,
  WEEKDAY_LABELS,
} from "./grid.ts";
import { levelOf, type Scale } from "./scale.ts";
import { type ColorScheme, schemeOf, type Theme } from "./scheme.ts";

export type GraphInput = {
  readonly today: string;
  /** 表示範囲の日ごとの分数。範囲外 (未来の日など) のキーがあっても無視する。 */
  readonly days: ReadonlyMap<string, Minutes>;
  /** `ph = '*'` の全期間から取った四分位。表示範囲とは別の母集団 (design §7)。 */
  readonly scale: Scale;
  /** 同じ母集団から取ったバランスの中心。 */
  readonly center: number;
  /**
   * 記録のある最も古い日 (計測開始とみなす。Issue #80)。
   * **これより前のマスは「計測していなかった」として塗らない** — 活動の無い日と区別する (ADR-0012)。
   * 表示範囲より前なら印は出ない (全マスが計測済みなので区別する必要が無い)
   */
  readonly startDay?: string;
  /**
   * この画像に描くプロジェクト名 (`?l=`。Issue #119)。**サーバは保存しない** —
   * 呼び出し側がクエリから読み、`isValidProjectName` を通ったものだけを渡す (ADR-0007 決定 2 の再改訂)
   */
  readonly label?: string;
  /**
   * この画像に描くユーザー名 (`?u=`。Issue #134)。`label` と同じく**サーバは保存しない** —
   * 呼び出し側が `isValidUserName` を通したものだけを渡す
   */
  readonly user?: string;
  readonly params: Params;
};

type Label = {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly anchor: "start" | "end";
  /** 太字にするか。プロジェクト名だけに付ける (Issue #119) */
  readonly weight?: "bold";
  /**
   * リンク先 (Issue #119)。**`<img>` で貼られている間は押せない** (research §3) が、
   * 画像そのものを開けば飛べる。プロジェクトの行にだけ付ける
   */
  readonly href?: string;
  /**
   * 同じ行に続けて描く文字列 (Issue #134。プロジェクト名の後のユーザー名)。**太字にもリンクにもしない。**
   * 位置を文字幅の見積もりで決めず、同じ `<text>` の `<tspan>` にしてブラウザに実際の幅で並べさせる
   */
  readonly suffix?: string;
};

type Swatch = { readonly x: number; readonly y: number; readonly fill: string };

export type GraphLayout = {
  readonly width: number;
  readonly height: number;
  /** マスの一辺と角の丸み */
  readonly cellSize: number;
  readonly cellRadius: number;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly textColor: string;
  /** 月 → 曜日 → 凡例の軸の順 */
  readonly labels: readonly Label[];
  /**
   * 格子のマス。日付の古い順 (`gridCells` の順)。
   * `beforeStart` のマスは**塗らず、点線の枠だけ**で描く (計測開始前。Issue #80)
   */
  readonly grid: readonly (Swatch & {
    readonly day: string;
    readonly minutes: Minutes;
    readonly beforeStart: boolean;
  })[];
  /** 計測開始前のマスの枠の色。`beforeStart` が 1 つも無ければ描かない */
  readonly mutedColor: string;
  /** 凡例のマス。量の帯 (Level 1〜4) → 読み書きの帯 (バランスの列) の順。write モードは量の帯だけ */
  readonly legend: readonly Swatch[];
};

const PADDING = 8;
const WEEKDAY_LABEL_WIDTH = 20;
const MONTH_LABEL_HEIGHT = 14;
const LEGEND_GAP = 10;
const LEGEND_AXIS_WIDTH = 30;
/** 帯の右端の文字 (「多い」「書く」) の幅 */
const LEGEND_TAIL_WIDTH = 24;
/** 量の帯と読み書きの帯の間 */
const LEGEND_STRIP_GAP = 8;
/** プロジェクト名と凡例の間 */
const PROJECT_LEGEND_GAP = 12;
/**
 * プロジェクト名の 1 文字あたりの見積もり幅。太字 9px の数字の実測 (6.4px) に合わせた
 * (2026-09-23、Hiragino Sans)。名前は英数字とハイフンだけ (`isValidProjectName`) なので、
 * `m` や大文字ばかりの名前でなければこれに収まる。**上限の 64 文字でも 53 週の幅 (775px) に収まる値**
 */
const PROJECT_CHAR_WIDTH = 6.5;
/**
 * ラベルの続き (`suffix`) の前に空ける幅 (px)。9px の文字で 1 文字弱。
 * `svg.ts` が `<tspan dx>` に使い、ここでは幅の見積もりに使う
 */
export const SUFFIX_GAP = 6;
/** ユーザー名の前に付ける印 (Issue #134) */
const USER_PREFIX = "@";
const LABEL_BASELINE = 9;
const FONT_SIZE = 9;
const CELL_RADIUS = 2;

// 外部フォントは読めないので OS の日本語フォントを並べる。CJK フォントの無い環境では文字化けする
const FONT_FAMILY =
  "'Hiragino Sans','Hiragino Kaku Gothic ProN','Noto Sans CJK JP','Yu Gothic',Meiryo,sans-serif";

// 背景は両テーマとも透明。埋め込み側がテーマを選ぶ前提で、文字色だけ変える
const TEXT_COLOR: Record<Theme, string> = { light: "#57606a", dark: "#9198a1" };

const LEGEND_LEVELS = [1, 2, 3, 4] as const;

/**
 * 読み書きの帯を塗る Level。**Level 4 はライトで暗く、色相の違いが読みにくい**ので、
 * 1 段下で見せる
 */
const BALANCE_STRIP_LEVEL = 3;

/**
 * 量の帯のバランス。中央の列 (読みと書きが半々) の色で濃淡だけを見せる。
 * **write モードの全マスと同じ値** (`WRITE_MODE_BALANCES`) なので、write モードの凡例は量の帯そのもの
 */
const AMOUNT_STRIP_BALANCE = 0;

/** 計測開始前のマスの枠 (design §8)。文字色より薄くして、記録のあるマスと取り違えないようにする */
const MUTED_COLOR: Record<Theme, string> = { light: "#d0d7de", dark: "#3d444d" };

/**
 * プロジェクトのページ (Issue #119)。**ラベルにも `href` にも同じものを使う** —
 * 見れば行き先が読め、SVG を開けばそのまま飛べる。
 */
const COSENSE_ORIGIN = "https://scrapbox.io";
const PROJECT_PREFIX = "scrapbox.io/";

// write モードは全マスのバランスを 0 とみなすので、凡例もバランス 0 の 1 列になる
const WRITE_MODE_BALANCES: readonly number[] = [0];

/** 凡例の列ごとのバランスの見本。スキームが決める。 */
function legendBalancesOf(params: Params, scheme: ColorScheme): readonly number[] {
  return params.mode === "write" ? WRITE_MODE_BALANCES : scheme.legendBalances;
}

function label(x: number, y: number, text: string, anchor: Label["anchor"] = "start"): Label {
  return { x, y, text, anchor };
}

/**
 * 凡例の行の左端に出す名前の行 (Issue #119・#134)。
 *
 * **プロジェクトは `scrapbox.io/<名前>` と太字で出し、同じ URL を `href` に持たせる。**
 * `<img>` で貼られている間はクリックできない (research §3) が、**画像そのものを開けば飛べる**。
 *
 * **ユーザー名は `@<名前>` として同じ行に続ける** (`suffix`)。太字にもリンクにもしない —
 * Cosense のユーザーページはプロジェクトに属し、全体で共通のページが無いのでリンク先が決まらない。
 * 合算の草 (プロジェクト名なし) ではユーザー名だけが左端に来る。
 *
 * **ここに置くのは寸法を増やさないため。** 草の寸法が変わると、`<img>` に寸法を固定している
 * UserScript 側 (`graph-dialog.ts` の `GRAPH_WIDTH` / `GRAPH_HEIGHT`) で絵が縮む。
 * 週数が少なく凡例と重なるときだけ横に広げる (`projectWidth`)。
 */
function projectLine(
  projectName: string | undefined,
  userName: string | undefined,
  y: number,
): Label[] {
  const user = userName === undefined ? undefined : `${USER_PREFIX}${userName}`;
  if (projectName === undefined) {
    return user === undefined ? [] : [label(PADDING, y, user)];
  }
  return [
    {
      x: PADDING,
      y,
      text: `${PROJECT_PREFIX}${projectName}`,
      anchor: "start",
      weight: "bold",
      href: `${COSENSE_ORIGIN}/${projectName}`,
      ...(user === undefined ? {} : { suffix: user }),
    },
  ];
}

/**
 * 名前の行が凡例と重ならないために取っておく幅 (見積もり)。名前が 1 つも無ければ 0。
 * ユーザー名は太字でないので実際は見積もりより狭いが、同じ幅で見積もって重ならない側に倒す
 */
function projectWidth(projectName: string | undefined, userName: string | undefined): number {
  const project =
    projectName === undefined
      ? 0
      : (PROJECT_PREFIX.length + projectName.length) * PROJECT_CHAR_WIDTH;
  const user =
    userName === undefined
      ? 0
      : (project === 0 ? 0 : SUFFIX_GAP) +
        (USER_PREFIX.length + userName.length) * PROJECT_CHAR_WIDTH;
  return project + user === 0 ? 0 : Math.ceil(project + user) + PROJECT_LEGEND_GAP;
}

/** 「少ない ■■■■ 多い」の形の帯 1 本の幅 */
function stripWidth(count: number): number {
  return LEGEND_AXIS_WIDTH + count * STEP - GAP + LEGEND_TAIL_WIDTH;
}

/**
 * 凡例の幅。**格子の下 1 行に、量の帯と読み書きの帯を並べる** (2026-09-23 改訂、Issue #133)。
 *
 * 4 行 × 5 列の 2 次元凡例は格子の下に 65px の高さを取り、左はプロジェクト名 1 行だけなので
 * 空白が目立った。2 つの軸それぞれの見本があれば色の意味は復元できる。
 * write モードは全マスのバランスが 0 なので、量の帯だけになる。
 */
function legendWidth(balances: readonly number[]): number {
  const amount = stripWidth(LEGEND_LEVELS.length);
  return balances.length === 1 ? amount : amount + LEGEND_STRIP_GAP + stripWidth(balances.length);
}

/** 帯 1 本 (`lowText` ■■■■ `highText`)。`x` は帯の左端 */
function layoutStrip(
  fills: readonly string[],
  lowText: string,
  highText: string,
  x: number,
  y: number,
): { readonly swatches: Swatch[]; readonly labels: Label[] } {
  const cellsX = x + LEGEND_AXIS_WIDTH;
  return {
    swatches: fills.map((fill, i) => ({ x: cellsX + i * STEP, y, fill })),
    labels: [
      label(cellsX - 4, y + LABEL_BASELINE, lowText, "end"),
      label(cellsX + fills.length * STEP, y + LABEL_BASELINE, highText),
    ],
  };
}

function layoutLegend(
  balances: readonly number[],
  scheme: ColorScheme,
  theme: Theme,
  x: number,
  y: number,
): { readonly swatches: Swatch[]; readonly labels: Label[] } {
  // 凡例のマスは total = Infinity で渡す。合計分数で彩度を変える配色でも飽和させるため
  const swatch = (level: (typeof LEGEND_LEVELS)[number], balance: number) =>
    scheme.cell({ level, balance, total: Number.POSITIVE_INFINITY }, theme);

  const amount = layoutStrip(
    LEGEND_LEVELS.map((level) => swatch(level, AMOUNT_STRIP_BALANCE)),
    "少ない",
    "多い",
    x,
    y,
  );
  // write モードはバランス 0 の 1 列だけなので、読み書きの帯は出さない
  if (balances.length === 1) {
    return amount;
  }
  const balance = layoutStrip(
    balances.map((b) => swatch(BALANCE_STRIP_LEVEL, b)),
    "読む",
    "書く",
    x + stripWidth(LEGEND_LEVELS.length) + LEGEND_STRIP_GAP,
    y,
  );
  return {
    swatches: [...amount.swatches, ...balance.swatches],
    labels: [...amount.labels, ...balance.labels],
  };
}

/**
 * 草のレイアウトを返す。
 *
 * **凡例は格子の下に右寄せで置く。** 右に置くと幅が増え、Cosense の本文幅で縮小される
 * (53 週で 870px 対 775px)。全体の幅は格子と「プロジェクト名 + 凡例」の大きい方
 * (`weeks` が小さいと凡例の行が広い)。
 */
export function layoutGraph(input: GraphInput): GraphLayout {
  const { params } = input;
  const scheme = schemeOf(params.palette);
  const cells = gridCells(input.today, params.weeks);
  const legendBalances = legendBalancesOf(params, scheme);

  const gridWidth = params.weeks * STEP - GAP;
  const gridHeight = DAYS * STEP - GAP;
  const legend = legendWidth(legendBalances);
  const contentWidth = Math.max(
    WEEKDAY_LABEL_WIDTH + gridWidth,
    projectWidth(input.label, input.user) + legend,
  );

  const gridX = PADDING + WEEKDAY_LABEL_WIDTH;
  const gridY = PADDING + MONTH_LABEL_HEIGHT;

  const grid = cells.map((cell: GridCell) => {
    const minutes = input.days.get(cell.day) ?? { w: 0, r: 0 };
    const beforeStart = input.startDay !== undefined && cell.day < input.startDay;
    const total = minutes.w + minutes.r;
    const level = levelOf(total, input.scale);
    // write モードは全マスのバランスを 0 とみなす。スキームごとの特別扱いを要らなくするため
    const balance = params.mode === "write" ? 0 : balanceOf(minutes, input.center);
    return {
      x: gridX + cell.column * STEP,
      y: gridY + cell.row * STEP,
      fill: scheme.cell({ level, balance, total }, params.theme),
      day: cell.day,
      minutes,
      beforeStart,
    };
  });

  const legendX = PADDING + contentWidth - legend;
  const legendY = gridY + gridHeight + LEGEND_GAP;
  const legendParts = layoutLegend(legendBalances, scheme, params.theme, legendX, legendY);

  return {
    // width / height / viewBox の 3 つを必ず出す。欠けると Cosense でサイズが崩れる (design §8)
    width: PADDING * 2 + contentWidth,
    height: PADDING + MONTH_LABEL_HEIGHT + gridHeight + LEGEND_GAP + CELL + PADDING,
    cellSize: CELL,
    cellRadius: CELL_RADIUS,
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    textColor: TEXT_COLOR[params.theme],
    mutedColor: MUTED_COLOR[params.theme],
    labels: [
      ...projectLine(input.label, input.user, legendY + LABEL_BASELINE),
      ...monthLabels(cells).map((month) =>
        label(gridX + month.position * STEP, PADDING + LABEL_BASELINE, month.text),
      ),
      ...WEEKDAY_LABELS.map((weekday) =>
        label(gridX - 4, gridY + weekday.position * STEP + LABEL_BASELINE, weekday.text, "end"),
      ),
      ...legendParts.labels,
    ],
    grid,
    legend: legendParts.swatches,
  };
}
