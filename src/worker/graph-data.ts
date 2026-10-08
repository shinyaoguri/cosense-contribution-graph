/**
 * 図 (`/v1/g/{publicId}.svg`・`/card.svg`・`/overview.svg`) を D1 の記録から描く (design §6・§7、ADR-0026)。
 *
 * - `publicId` を `graphs` で引き、全体用 (`ph = '*'`) かプロジェクト別かを決める。無ければ `undefined` (404)
 * - **四分位とバランスの中心は、常に `ph = '*'` の全期間から取る** (ADR-0007 決定 4)。プロジェクト別の図も
 *   同じスケールで塗るので、並べて比べられる
 * - プロジェクト別は表示範囲 (と右端の翌日) だけを読む
 */

import { fromEpochDay, toEpochDay } from "../shared/epoch-day.ts";
import { SPAN_WEEKS } from "../shared/grass.ts";
import { PH_ALL } from "../shared/ids.ts";
import { DEFAULT_TIME_ZONE, todayIn } from "./days.ts";
import type { Minutes } from "./graph/balance.ts";
import { centerOf } from "./graph/balance.ts";
import { type GrassDay, grassStart, slotPopulation } from "./graph/grass.ts";
import { buildScale } from "./graph/scale.ts";
import { renderGrass } from "./grass-svg.ts";
import type { GrassParams } from "./params.ts";

/**
 * **右端の日。** 既定は今日で、`?year=` があればその年の 12/31 まで遡る (Issue #128)。
 * **未来は受けない** — 今年を指定したときは自然と「今日が右端」になる
 */
function rightEdge(nowMs: number, end?: string): string {
  const realToday = todayIn(DEFAULT_TIME_ZONE, nowMs);
  return end !== undefined && end < realToday ? end : realToday;
}

/** 図で読む列 (`daily` の w / r と 4 軸、時間帯の区間) */
export type GrassRow = {
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

const GRASS_COLUMNS = "day, w, r, wc, wo, sw0, sw1, sw2, sw3, sr0, sr1, sr2, sr3";

/** 行を `GrassDay` にする。**区間の 8 列のどれかが NULL なら内訳なし** (8 列はそろって NULL か、そろって値を持つ) */
export function grassDayOf(row: GrassRow): GrassDay {
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

export type GrassOptions = GrassParams & {
  /** 画像に描くプロジェクト名 (`?l=`)。その要求で渡されたもので、保存しない */
  readonly label?: string;
  /** 画像に描くユーザー名 (`?u=`)。同上 */
  readonly user?: string;
};

/**
 * D1 の記録から図を描く (ADR-0024・0026)。`publicId` が `graphs` に無ければ `undefined`。D1 の失敗は throw する。
 *
 * - 期間は形 (`span`) の週数。右端の日の決め方は草と同じ (`rightEdge`。`?year=` ならその年の 12/31)
 * - 表示する行と `ph = '*'` の母集団を 1 回の batch で読む (`loadGraph` と同じ形)。合算は 1 回だけ読む
 * - **表示する行は右端の翌日まで読む。** 右端の日の夜は翌日の区間 0 を足して組み立てる (過去の年の 12/31 の夜)
 * - 計測開始日は母集団 (`ph = '*'` の全期間) の最も古い日 (草と同じ。Issue #80)
 * - **アイコンは `l` と `u` がそろい、合算でないときだけ取りに行く** (`icon` は注入。D1 の読み取りと並べて待つ)
 */
export async function renderStoredGrass(
  db: D1Database,
  publicId: string,
  options: GrassOptions,
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

  const today = todayIn(DEFAULT_TIME_ZONE, nowMs);
  const end = rightEdge(nowMs, options.end);
  const total = graph.ph === PH_ALL;
  const populationQuery = db
    .prepare(`SELECT ${GRASS_COLUMNS} FROM daily WHERE uid = ? AND ph = ?`)
    .bind(graph.uid, PH_ALL);
  const readRows = async (): Promise<readonly [readonly GrassRow[], readonly GrassRow[]]> => {
    if (total) {
      // 合算は母集団と表示する行が同じなので 1 回だけ読む。表示範囲の外は描画が無視する
      const rows = (await populationQuery.all<GrassRow>()).results;
      return [rows, rows];
    }
    const [population, display] = await db.batch<GrassRow>([
      populationQuery,
      db
        .prepare(
          `SELECT ${GRASS_COLUMNS} FROM daily WHERE uid = ? AND ph = ? AND day >= ? AND day <= ?`,
        )
        .bind(
          graph.uid,
          graph.ph,
          grassStart(end, SPAN_WEEKS[options.form.span]),
          fromEpochDay(toEpochDay(end) + 1),
        ),
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

  const population = new Map(populationRows.map((row) => [row.day, grassDayOf(row)]));
  const slots = slotPopulation(population);
  const dayMinutes = populationRows.map((row): Minutes => ({ w: row.w, r: row.r }));
  const startDay = populationRows.reduce<string | undefined>(
    (oldest, row) => (oldest === undefined || row.day < oldest ? row.day : oldest),
    undefined,
  );
  return renderGrass({
    today,
    end,
    form: options.form,
    mode: options.mode,
    startDay,
    days: total ? population : new Map(displayRows.map((row) => [row.day, grassDayOf(row)])),
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
