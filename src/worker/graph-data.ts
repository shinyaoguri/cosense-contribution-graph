/**
 * 共有グラフ `/v1/g/{publicId}.svg` を D1 の記録から描く (design §6・§7)。
 *
 * - `publicId` を `graphs` で引き、全体用 (`ph = '*'`) かプロジェクト別かを決める。無ければ `undefined` (404)
 * - **四分位とバランスの中心は、常に `ph = '*'` の全期間から取る** (ADR-0007 決定 4)。プロジェクト別の草も
 *   同じスケールで塗るので、並べて比べられる
 * - プロジェクト別は直近 53 週ぶんだけを読む。週数を減らしたときの切り詰めは `renderGraph` がする
 *
 * 活動の概観 `/v1/g/{publicId}/overview.svg` (ADR-0021) も同じ `publicId` を同じく引き、**草と同じ期間**を合計して描く。
 * カードの図 `/v1/g/{publicId}/card.svg` (ADR-0024) も同じく引き、直近 26 週と `ph = '*'` の母集団を読む。
 */

import { fromEpochDay, toEpochDay } from "../shared/epoch-day.ts";
import { PH_ALL } from "../shared/ids.ts";
import { renderCard } from "./card-svg.ts";
import { DEFAULT_TIME_ZONE, todayIn } from "./days.ts";
import type { Minutes } from "./graph/balance.ts";
import { centerOf } from "./graph/balance.ts";
import { type CardDay, cardStart, type Lang, slotPopulation } from "./graph/card.ts";
import { DAYS, MAX_WEEKS, type Params } from "./graph/grid.ts";
import { type OverviewDay, sumOverview } from "./graph/overview.ts";
import { buildScale } from "./graph/scale.ts";
import type { SchemeName, Theme } from "./graph/scheme.ts";
import { renderOverview } from "./overview-svg.ts";
import { renderGraph } from "./svg.ts";

type DayRow = { readonly day: string; readonly w: number; readonly r: number };

type StoredGraph = {
  readonly today: string;
  /** 合算の草 (`ph = '*'`) か */
  readonly total: boolean;
  /** 表示範囲の日ごとの分数 */
  readonly days: ReadonlyMap<string, Minutes>;
  /** `ph = '*'` の全期間 */
  readonly population: readonly Minutes[];
  /**
   * 記録のある最も古い日 (Issue #80)。**`ph = '*'` の全期間から取る。**
   * プロジェクト別は表示範囲しか読まないので、そこから取ると「範囲の端」を計測開始と取り違える
   */
  readonly startDay?: string;
};

async function loadGraph(
  db: D1Database,
  publicId: string,
  nowMs: number,
  end?: string,
): Promise<StoredGraph | undefined> {
  const graph = await db
    .prepare("SELECT uid, ph FROM graphs WHERE public_id = ?")
    .bind(publicId)
    .first<{ uid: string; ph: string }>();
  if (!graph) {
    return undefined;
  }

  const today = rightEdge(nowMs, end);
  const start = fromEpochDay(toEpochDay(today) - DAYS * (MAX_WEEKS - 1));
  const populationQuery = db
    .prepare("SELECT day, w, r FROM daily WHERE uid = ? AND ph = ?")
    .bind(graph.uid, PH_ALL);

  let populationRows: readonly DayRow[];
  let displayRows: readonly DayRow[];
  if (graph.ph === PH_ALL) {
    // 全体用は母集団と表示する行が同じなので、1 回だけ読む (読み取り行数を倍にしない)。
    // 表示範囲より古い日は renderGraph が無視する
    populationRows = (await populationQuery.all<DayRow>()).results;
    displayRows = populationRows;
  } else {
    const [population, display] = await db.batch<DayRow>([
      populationQuery,
      db
        .prepare("SELECT day, w, r FROM daily WHERE uid = ? AND ph = ? AND day >= ?")
        .bind(graph.uid, graph.ph, start),
    ]);
    populationRows = population?.results ?? [];
    displayRows = display?.results ?? [];
  }

  const minutes = (row: DayRow): Minutes => ({ w: row.w, r: row.r });
  const startDay = populationRows.reduce<string | undefined>(
    (oldest, row) => (oldest === undefined || row.day < oldest ? row.day : oldest),
    undefined,
  );
  return {
    today,
    total: graph.ph === PH_ALL,
    days: new Map(displayRows.map((row) => [row.day, minutes(row)])),
    population: populationRows.map(minutes),
    startDay,
  };
}

/**
 * **右端の日。** 既定は今日で、`?year=` があればその年の 12/31 まで遡る (Issue #128)。
 * **未来は受けない** — 今年を指定したときは自然と「今日が右端」になる
 */
function rightEdge(nowMs: number, end?: string): string {
  const realToday = todayIn(DEFAULT_TIME_ZONE, nowMs);
  return end !== undefined && end < realToday ? end : realToday;
}

/**
 * D1 の記録から活動の概観の SVG を描く (ADR-0021)。`publicId` が `graphs` に無ければ `undefined`。D1 の失敗は throw する。
 *
 * 期間は草と同じ `[右端 − 7 × (weeks − 1), 右端]`。四分位もバランスの中心も要らないので、その期間の行だけを読む。
 */
export async function renderStoredOverview(
  db: D1Database,
  publicId: string,
  params: Params,
  nowMs: number,
  end?: string,
): Promise<string | undefined> {
  const graph = await db
    .prepare("SELECT uid, ph FROM graphs WHERE public_id = ?")
    .bind(publicId)
    .first<{ uid: string; ph: string }>();
  if (!graph) {
    return undefined;
  }
  const today = rightEdge(nowMs, end);
  const start = fromEpochDay(toEpochDay(today) - DAYS * (params.weeks - 1));
  const { results } = await db
    .prepare("SELECT w, r, wc, wo FROM daily WHERE uid = ? AND ph = ? AND day >= ? AND day <= ?")
    .bind(graph.uid, graph.ph, start, today)
    .all<OverviewDay>();
  return renderOverview({
    totals: sumOverview(results),
    theme: params.theme,
    palette: params.palette,
  });
}

/** D1 の記録から SVG を描く。`publicId` が `graphs` に無ければ `undefined`。D1 の失敗は throw する。 */
export async function renderStoredGraph(
  db: D1Database,
  publicId: string,
  params: Params,
  nowMs: number,
  /** 画像に描くプロジェクト名 (`?l=`。Issue #119)。**保存されている値ではなく、その要求で渡されたもの** */
  label?: string,
  /** 草の右端にする日 (`?year=` から導く。Issue #128)。既定は今日 */
  end?: string,
  /** 画像に描くユーザー名 (`?u=`。Issue #134)。`label` と同じく、その要求で渡されたもの */
  user?: string,
): Promise<string | undefined> {
  const graph = await loadGraph(db, publicId, nowMs, end);
  if (!graph) {
    return undefined;
  }
  return renderGraph({
    today: graph.today,
    days: graph.days,
    scale: buildScale(graph.population.map((d) => d.w + d.r)),
    center: centerOf(graph.population),
    startDay: graph.startDay,
    label,
    user,
    // 合算かどうかは publicId が決める (クエリでは指定しない)。合算の草にだけ印を描く
    total: graph.total,
    params,
  });
}

/** カードの図で読む列 (`daily` の w / r と 4 軸、時間帯の区間) */
type CardRow = {
  readonly day: string;
  readonly w: number;
  readonly r: number;
  readonly wc: number;
  readonly wo: number;
  readonly sw0: number | null;
  readonly sw1: number | null;
  readonly sw2: number | null;
  readonly sw3: number | null;
  readonly sr0: number | null;
  readonly sr1: number | null;
  readonly sr2: number | null;
  readonly sr3: number | null;
};

const CARD_COLUMNS = "day, w, r, wc, wo, sw0, sw1, sw2, sw3, sr0, sr1, sr2, sr3";

/** 行を `CardDay` にする。**区間の 8 列のどれかが NULL なら内訳なし** (8 列はそろって NULL か、そろって値を持つ) */
function cardDayOf(row: CardRow): CardDay {
  const { w, r, wc, wo, sw0, sw1, sw2, sw3, sr0, sr1, sr2, sr3 } = row;
  const base = { w, r, wc, wo };
  if (
    sw0 === null ||
    sw1 === null ||
    sw2 === null ||
    sw3 === null ||
    sr0 === null ||
    sr1 === null ||
    sr2 === null ||
    sr3 === null
  ) {
    return base;
  }
  return { ...base, segments: { w: [sw0, sw1, sw2, sw3], r: [sr0, sr1, sr2, sr3] } };
}

export type CardOptions = {
  readonly theme: Theme;
  readonly palette: SchemeName;
  readonly lang: Lang;
  /** 画像に描くプロジェクト名 (`?l=`)。その要求で渡されたもので、保存しない */
  readonly label?: string;
  /** 画像に描くユーザー名 (`?u=`)。同上 */
  readonly user?: string;
};

/**
 * D1 の記録からカードの図を描く (ADR-0024)。`publicId` が `graphs` に無ければ `undefined`。D1 の失敗は throw する。
 *
 * - 期間は右端の日 (今日) の週から 26 週。右端の日の決め方は草と同じ (`rightEdge`)。`year` は受けない
 * - 表示する行と `ph = '*'` の母集団を 1 回の batch で読む (`loadGraph` と同じ形)。合算は 1 回だけ読む
 * - **アイコンは `l` と `u` がそろい、合算でないときだけ取りに行く** (`icon` は注入。D1 の読み取りと並べて待つ)
 */
export async function renderStoredCard(
  db: D1Database,
  publicId: string,
  options: CardOptions,
  nowMs: number,
  icon: (project: string, user: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const graph = await db
    .prepare("SELECT uid, ph FROM graphs WHERE public_id = ?")
    .bind(publicId)
    .first<{ uid: string; ph: string }>();
  if (!graph) {
    return undefined;
  }

  const today = rightEdge(nowMs);
  const total = graph.ph === PH_ALL;
  const populationQuery = db
    .prepare(`SELECT ${CARD_COLUMNS} FROM daily WHERE uid = ? AND ph = ?`)
    .bind(graph.uid, PH_ALL);
  const readRows = async (): Promise<readonly [readonly CardRow[], readonly CardRow[]]> => {
    if (total) {
      // 合算は母集団と表示する行が同じなので 1 回だけ読む。表示範囲の外は描画が無視する
      const rows = (await populationQuery.all<CardRow>()).results;
      return [rows, rows];
    }
    const [population, display] = await db.batch<CardRow>([
      populationQuery,
      db
        .prepare(
          `SELECT ${CARD_COLUMNS} FROM daily WHERE uid = ? AND ph = ? AND day >= ? AND day <= ?`,
        )
        .bind(graph.uid, graph.ph, cardStart(today), today),
    ]);
    return [population?.results ?? [], display?.results ?? []];
  };
  const { label, user } = options;
  const [[populationRows, displayRows], iconUri] = await Promise.all([
    readRows(),
    total || label === undefined || user === undefined
      ? Promise.resolve(undefined)
      : icon(label, user),
  ]);

  const population = new Map(populationRows.map((row) => [row.day, cardDayOf(row)]));
  const slots = slotPopulation(population);
  const dayMinutes = populationRows.map((row): Minutes => ({ w: row.w, r: row.r }));
  return renderCard({
    today,
    days: total ? population : new Map(displayRows.map((row) => [row.day, cardDayOf(row)])),
    slotScale: buildScale(slots.map((m) => m.w + m.r)),
    slotCenter: centerOf(slots),
    dayScale: buildScale(dayMinutes.map((m) => m.w + m.r)),
    dayCenter: centerOf(dayMinutes),
    theme: options.theme,
    palette: options.palette,
    lang: options.lang,
    label,
    user,
    icon: iconUri,
    total,
  });
}
