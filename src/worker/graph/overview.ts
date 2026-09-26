/**
 * 活動の概観 (4 軸のレーダー) の寸法・色・ラベルの位置を決める (design §8、ADR-0021)。
 * 文字列にするのは `overview-svg.ts`。草の `layout.ts` と同じ分け方。
 *
 * GitHub の Activity overview に合わせる (research §8)。ただし長さだけは変える (ADR-0021 の 2026-09-26 の改訂)。
 * - 配置は十字で、上 関わる / 右 読む / 下 作る / 左 育てる
 * - 長さは「値 ÷ 4 軸の最大値」の**平方根**。最大の軸が端に届く。
 *   GitHub の線形では、最大の軸 (多くは 読む) の数 % しかない軸が中心近くの点に潰れる
 * - % は合計が 100 になる整数。0 の軸は % も頂点の円も出さず、頂点を中心に置く
 * - 全部 0 なら四角形を描かない (十字と軸名は出す)
 */
import { FONT_FAMILY, MUTED_COLOR, TEXT_COLOR } from "./layout.ts";
import { type SchemeName, schemeOf, type Theme } from "./scheme.ts";

/** 期間の 4 軸の合計 (分)。 */
export type OverviewTotals = {
  /** 育てる (自分が前に作ったページに書いた分) */
  readonly grow: number;
  /** 作る (その日に自分が作ったページに書いた分) */
  readonly create: number;
  /** 関わる (他の人が作ったページに書いた分) */
  readonly join: number;
  /** 読む (読んだだけの分) */
  readonly read: number;
};

/** `daily` の 1 日。 */
export type OverviewDay = {
  readonly w: number;
  readonly r: number;
  readonly wc: number;
  readonly wo: number;
};

/**
 * 日ごとの値を期間で合計する。**育てるは日ごとに 0 で打ち切ってから足す** (design §4)。
 * 端末をまたぐと `wc` / `wo` を max で守るので、`wc + wo` が `w` を超える日がある。
 */
export function sumOverview(days: Iterable<OverviewDay>): OverviewTotals {
  let grow = 0;
  let create = 0;
  let join = 0;
  let read = 0;
  for (const day of days) {
    grow += Math.max(0, day.w - day.wc - day.wo);
    create += day.wc;
    join += day.wo;
    read += day.r;
  }
  return { grow, create, join, read };
}

/**
 * 合計が 100 になる整数の % (最大剰余法)。切り捨てた後、端数の大きい順に 1 ずつ足す。
 * **端数が同じなら並びの先を優先する。** 全部 0 なら全部 0。
 *
 * GitHub の丸め方は推定しかできず、四捨五入では合計が 99 や 101 になるので、必ず 100 になる方にした (design §8)。
 */
export function percentages(values: readonly number[]): number[] {
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum === 0) {
    return values.map(() => 0);
  }
  const exact = values.map((v) => (v * 100) / sum);
  const result = exact.map(Math.floor);
  const order = exact
    .map((v, i) => ({ i, remainder: v - Math.floor(v) }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  let rest = 100 - result.reduce((a, b) => a + b, 0);
  for (const { i } of order) {
    if (rest === 0) {
      break;
    }
    result[i] = (result[i] ?? 0) + 1;
    rest--;
  }
  return result;
}

/** 軸の並び。上・右・下・左の順 (% の端数が同じときの優先もこの順)。 */
const AXES = [
  { key: "join", name: "関わる", dx: 0, dy: -1 },
  { key: "read", name: "読む", dx: 1, dy: 0 },
  { key: "create", name: "作る", dx: 0, dy: 1 },
  { key: "grow", name: "育てる", dx: -1, dy: 0 },
] as const satisfies readonly {
  key: keyof OverviewTotals;
  name: string;
  dx: number;
  dy: number;
}[];

// 寸法 (design §8 の叩き台)
const WIDTH = 300;
const HEIGHT = 220;
const CENTER_X = WIDTH / 2;
const CENTER_Y = HEIGHT / 2;
/** 中心から軸の端まで */
const RADIUS = 70;
/** 軸の端からラベルまで */
const LABEL_GAP = 8;
/** 上下のラベルのベースラインの位置の補正 (文字の高さの分) */
const LABEL_ASCENT = 9;
/** 左右のラベルを軸の高さに揃える補正 */
const LABEL_MIDDLE = 4;
/**
 * 草 (9px) より大きくする。草の文字はマスの 11px に合わせた大きさで、概観はマスが無いので読みやすさを優先する。
 * 左の「育てる 100%」でも約 63px で、左端から 9px 残る
 */
const FONT_SIZE = 11;

/** 塗りを量の帯の何段で塗るか (凡例の読み書きの帯と同じ段。design §8) */
const SHAPE_LEVEL = 3;
/** 頂点の円の中の色。GitHub は白 */
const VERTEX_FILL: Record<Theme, string> = { light: "#ffffff", dark: "#0d1117" };

type Point = { readonly x: number; readonly y: number };

type OverviewLabel = Point & {
  readonly anchor: "start" | "middle" | "end";
  readonly name: string;
  /** 0 の軸は出さない */
  readonly percent?: number;
};

export type OverviewLayout = {
  readonly width: number;
  readonly height: number;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly textColor: string;
  /** 十字の色 */
  readonly axisColor: string;
  /** 四角形と頂点の円の縁の色 */
  readonly shapeColor: string;
  readonly vertexFill: string;
  /** 十字 (縦と横の 2 本) */
  readonly axes: readonly { readonly from: Point; readonly to: Point }[];
  /** 四角形の頂点 (上・右・下・左)。**全部 0 なら無い** */
  readonly shape?: readonly Point[];
  /** 0 でない軸の頂点 */
  readonly vertices: readonly Point[];
  readonly labels: readonly OverviewLabel[];
};

export type OverviewInput = {
  readonly totals: OverviewTotals;
  readonly theme: Theme;
  readonly palette: SchemeName;
};

const round = (n: number) => Math.round(n * 100) / 100;

export function layoutOverview(input: OverviewInput): OverviewLayout {
  const values = AXES.map((axis) => input.totals[axis.key]);
  const max = Math.max(...values);
  const percents = percentages(values);

  const tips = AXES.map((axis, i) => {
    // 面積がおおむね値に比例する。最大の 5 % の値なら、線形では 0.05、平方根では 0.22 の長さになる
    const length = max === 0 ? 0 : Math.sqrt((values[i] ?? 0) / max) * RADIUS;
    return { x: round(CENTER_X + axis.dx * length), y: round(CENTER_Y + axis.dy * length) };
  });

  const labels = AXES.map((axis, i): OverviewLabel => {
    const x = CENTER_X + axis.dx * (RADIUS + LABEL_GAP);
    const y =
      axis.dy === 0
        ? CENTER_Y + LABEL_MIDDLE
        : CENTER_Y + axis.dy * (RADIUS + LABEL_GAP) + (axis.dy > 0 ? LABEL_ASCENT : 0);
    const anchor = axis.dx > 0 ? "start" : axis.dx < 0 ? "end" : "middle";
    const value = values[i] ?? 0;
    return value === 0
      ? { x, y, anchor, name: axis.name }
      : { x, y, anchor, name: axis.name, percent: percents[i] ?? 0 };
  });

  const shapeColor = schemeOf(input.palette).cell(
    { level: SHAPE_LEVEL, balance: 0, total: Number.POSITIVE_INFINITY },
    input.theme,
  );
  return {
    width: WIDTH,
    height: HEIGHT,
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    textColor: TEXT_COLOR[input.theme],
    axisColor: MUTED_COLOR[input.theme],
    shapeColor,
    vertexFill: VERTEX_FILL[input.theme],
    axes: [
      { from: { x: CENTER_X, y: CENTER_Y - RADIUS }, to: { x: CENTER_X, y: CENTER_Y + RADIUS } },
      { from: { x: CENTER_X - RADIUS, y: CENTER_Y }, to: { x: CENTER_X + RADIUS, y: CENTER_Y } },
    ],
    ...(max === 0 ? {} : { shape: tips }),
    vertices: tips.filter((_, i) => (values[i] ?? 0) > 0),
    labels,
  };
}
