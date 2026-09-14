/**
 * 共有グラフ `/v1/g/{publicId}.svg` を D1 の記録から描く (design §6・§7)。
 *
 * - `publicId` を `graphs` で引き、全体用 (`ph = '*'`) かプロジェクト別かを決める。無ければ `undefined` (404)
 * - **四分位とバランスの中心は、常に `ph = '*'` の全期間から取る** (ADR-0007 決定 4)。プロジェクト別の草も
 *   同じスケールで塗るので、並べて比べられる
 * - プロジェクト別は直近 53 週ぶんだけを読む。週数を減らしたときの切り詰めは `renderGraph` がする
 */
import type { Minutes } from "../shared/balance.ts";
import { centerOf } from "../shared/balance.ts";
import { DAYS, fromEpochDay, MAX_WEEKS, type Params, toEpochDay } from "../shared/graph.ts";
import { PH_ALL } from "../shared/ids.ts";
import { buildScale } from "../shared/scale.ts";
import { DEFAULT_TIME_ZONE, todayIn } from "./days.ts";
import { renderGraph } from "./svg.ts";

type DayRow = { readonly day: string; readonly w: number; readonly r: number };

type StoredGraph = {
  readonly today: string;
  /** 表示範囲の日ごとの分数 */
  readonly days: ReadonlyMap<string, Minutes>;
  /** `ph = '*'` の全期間 */
  readonly population: readonly Minutes[];
};

async function loadGraph(
  db: D1Database,
  publicId: string,
  nowMs: number,
): Promise<StoredGraph | undefined> {
  const graph = await db
    .prepare("SELECT uid, ph FROM graphs WHERE public_id = ?")
    .bind(publicId)
    .first<{ uid: string; ph: string }>();
  if (!graph) {
    return undefined;
  }

  const today = todayIn(DEFAULT_TIME_ZONE, nowMs);
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
  return {
    today,
    days: new Map(displayRows.map((row) => [row.day, minutes(row)])),
    population: populationRows.map(minutes),
  };
}

/** D1 の記録から SVG を描く。`publicId` が `graphs` に無ければ `undefined`。D1 の失敗は throw する。 */
export async function renderStoredGraph(
  db: D1Database,
  publicId: string,
  params: Params,
  nowMs: number,
): Promise<string | undefined> {
  const graph = await loadGraph(db, publicId, nowMs);
  if (!graph) {
    return undefined;
  }
  return renderGraph({
    today: graph.today,
    days: graph.days,
    scale: buildScale(graph.population.map((d) => d.w + d.r)),
    center: centerOf(graph.population),
    params,
  });
}
