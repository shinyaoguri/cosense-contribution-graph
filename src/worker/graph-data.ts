/**
 * 共有グラフ `/v1/g/{publicId}.svg` を D1 の記録から描く (design §6・§7)。
 *
 * - `publicId` を `graphs` で引き、全体用 (`ph = '*'`) かプロジェクト別かを決める。無ければ `undefined` (404)
 * - **四分位とバランスの中心は、常に `ph = '*'` の全期間から取る** (ADR-0007 決定 4)。プロジェクト別の草も
 *   同じスケールで塗るので、並べて比べられる
 * - プロジェクト別は直近 53 週ぶんだけを読む。週数を減らしたときの切り詰めは `renderGraph` がする
 */

import { fromEpochDay, toEpochDay } from "../shared/epoch-day.ts";
import { PH_ALL } from "../shared/ids.ts";
import { DEFAULT_TIME_ZONE, todayIn } from "./days.ts";
import type { Minutes } from "./graph/balance.ts";
import { centerOf } from "./graph/balance.ts";
import { DAYS, MAX_WEEKS, type Params } from "./graph/grid.ts";
import { buildScale } from "./graph/scale.ts";
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

  // **右端の日。** 既定は今日で、`?year=` があればその年の 12/31 まで遡る (Issue #128)。
  // **未来は受けない** — 今年を指定したときは自然と「今日が右端」になる
  const realToday = todayIn(DEFAULT_TIME_ZONE, nowMs);
  const today = end !== undefined && end < realToday ? end : realToday;
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
