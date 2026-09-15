/**
 * 「草を見る」に並べる草を決める (design §9「表示」、段階 8、Issue #73)。**DOM を触らない純粋な部分**で、描くのは `graph-dialog.ts`。
 *
 * **全端末を統合した記録** (`describeIntegrated`)
 * - 草の URL は `sender.status()` の値をそのまま使う。**publicId の導き方を 2 か所に書かない** (#72)
 * - 並べられるプロジェクトは、このブラウザで直近 30 日に記録したものだけ。サーバはプロジェクト名を持たないので、
 *   ほかの端末だけで使ったプロジェクトは名前が分からない (ADR-0007)
 * - 並びは合算、今のプロジェクト、残りは `status()` の順 (名前の順)
 *
 * **このブラウザの記録** (`describeLocal`)
 * - `store.readRange` で直近 371 日を 1 回だけ読み、共有 SVG と同じ `layoutGraph` の入力を作る
 * - **四分位とバランスの中心は、このブラウザの合算の全期間から取る。** プロジェクト別も同じスケールで塗る (ADR-0007 決定 4)
 * - 並びは合算、今のプロジェクト、残りは表示範囲の合計分数の多い順
 */
import { centerOf, type Minutes } from "../shared/balance.ts";
import { DAYS, DEFAULT_PARAMS, fromEpochDay, MAX_WEEKS, toEpochDay } from "../shared/graph.ts";
import type { GraphInput } from "../shared/graph-layout.ts";
import { buildScale } from "../shared/scale.ts";
import { SIGN_IN_MENU_TITLE } from "./auth.ts";
import type { SendStatus } from "./sender.ts";
import { type Counts, DAILY_DAYS, type DayView } from "./store.ts";

export const VIEW_MENU_TITLE = "草を見る";

/** 最初に出すプロジェクト別の草の数。統合の方は、開くたびの Worker へのリクエストと D1 の読み取りを抑える */
export const INITIAL_PROJECT_GRAPHS = 5;

export type GraphEntry = {
  readonly label: string;
  readonly url: string;
  /**
   * このブラウザから 1 件でも送れたか。false なら草はまだ無いかもしれない (ほかの端末から送っていればある) ので、
   * **押されるまで画像を読まない** (404 のリクエストを出さず、URL をコンソールのエラーに残さない)
   */
  readonly sent: boolean;
};

export type IntegratedView =
  | { readonly kind: "message"; readonly lines: readonly string[] }
  | {
      readonly kind: "graphs";
      readonly total: GraphEntry;
      /** 今のプロジェクトが先頭 (記録があれば) */
      readonly projects: readonly GraphEntry[];
    };

export type LocalGraph = {
  readonly label: string;
  readonly input: GraphInput;
  /** 日 → その日の集計値。ツールチップに出す (記録の無い日は無い) */
  readonly counts: ReadonlyMap<string, Counts>;
};

export type LocalView = {
  readonly total: LocalGraph;
  /** 表示範囲に記録のあるプロジェクト。今のプロジェクトが先頭 */
  readonly projects: readonly LocalGraph[];
};

export type ViewModel = {
  readonly integrated: IntegratedView;
  readonly local: LocalView;
};

export const TOTAL_LABEL = "合算 (UserScript を入れた全プロジェクト)";

export const LOCAL_TOTAL_LABEL = "合算 (このブラウザで数えた全プロジェクト)";

/** このブラウザの草で読む日数。草は 53 週を描き、四分位の母集団は集計値を持つ 371 日ぶん */
const LOCAL_DAYS = DAILY_DAYS;

export function describeIntegrated(status: SendStatus, currentProject: string): IntegratedView {
  switch (status.kind) {
    case "not-enrolled":
      return message(
        "この端末は未登録なので、全端末を統合した草はまだ見られません。",
        `ページメニューの「${SIGN_IN_MENU_TITLE}」から登録してください。`,
      );
    case "newer-key":
      return message(
        "新しい版の cosense-grass が登録した鍵なので、この版では草を出しません。新しい版を使ってください。",
      );
    case "newer-sent":
      return message(
        "新しい版の cosense-grass が送信の記録を書いているので、この版では草を出しません。新しい版を使ってください。",
      );
    case "storage":
      return message(
        "このブラウザの保存領域 (IndexedDB) を開けないので、草の URL を作れません。ページを開き直してください。",
      );
    case "enrolled": {
      const current = status.projects.filter((project) => project.name === currentProject);
      const others = status.projects.filter((project) => project.name !== currentProject);
      return {
        kind: "graphs",
        total: { label: TOTAL_LABEL, url: status.graphUrl, sent: true },
        projects: [
          ...current.map((project) => ({
            label: currentLabel(project.name),
            url: project.graphUrl,
            sent: project.sent,
          })),
          ...others.map((project) => ({
            label: project.name,
            url: project.graphUrl,
            sent: project.sent,
          })),
        ],
      };
    }
  }
}

/** 今日から前へ何日ぶん読むか。`readRange(localRangeStart(today), today)` で使う */
export function localRangeStart(today: string): string {
  return fromEpochDay(toEpochDay(today) - (LOCAL_DAYS - 1));
}

/**
 * このブラウザの記録から草を作る。`days` は `store.readRange(localRangeStart(today), today)` の結果。
 */
export function describeLocal(
  days: ReadonlyMap<string, DayView>,
  today: string,
  currentProject: string,
): LocalView {
  const displayStart = fromEpochDay(toEpochDay(today) - DAYS * (MAX_WEEKS - 1));
  const population: Minutes[] = [...days.values()].map(({ total }) => minutesOf(total.counts));
  const scale = buildScale(population.map((d) => d.w + d.r));
  const center = centerOf(population);

  const graph = (label: string, counts: ReadonlyMap<string, Counts>): LocalGraph => ({
    label,
    counts,
    input: {
      today,
      days: new Map([...counts].map(([day, value]) => [day, minutesOf(value)])),
      scale,
      center,
      params: DEFAULT_PARAMS,
    },
  });

  const totals = new Map<string, Counts>();
  const byProject = new Map<string, Map<string, Counts>>();
  for (const [day, view] of days) {
    if (day < displayStart || day > today) {
      continue;
    }
    if (!isEmpty(view.total.counts)) {
      totals.set(day, view.total.counts);
    }
    for (const [project, row] of view.projects) {
      if (isEmpty(row.counts)) {
        continue;
      }
      let counts = byProject.get(project);
      if (!counts) {
        counts = new Map();
        byProject.set(project, counts);
      }
      counts.set(day, row.counts);
    }
  }

  const minutesIn = (counts: ReadonlyMap<string, Counts>) =>
    [...counts.values()].reduce((sum, c) => sum + c.w + c.r, 0);
  const names = [...byProject.keys()].sort((a, b) => {
    if (a === currentProject || b === currentProject) {
      return a === currentProject ? -1 : 1;
    }
    const difference =
      minutesIn(byProject.get(b) ?? new Map()) - minutesIn(byProject.get(a) ?? new Map());
    // 同じ分数なら名前の順。localeCompare は環境で結果が変わりうるのでコード単位で比べる
    return difference !== 0 ? difference : a < b ? -1 : 1;
  });

  return {
    total: graph(LOCAL_TOTAL_LABEL, totals),
    projects: names.map((name) =>
      graph(name === currentProject ? currentLabel(name) : name, byProject.get(name) ?? new Map()),
    ),
  };
}

/** ツールチップの文言 (design §9)。記録の無い日は「記録なし」 */
export function tooltipOf(day: string, counts: Counts | undefined): string {
  if (counts === undefined || isEmpty(counts)) {
    return `${day} — 記録なし`;
  }
  return `${day} — 書き ${counts.w} 分 / 読み ${counts.r} 分 / ${counts.pages} ページ編集 / ${counts.created} ページ新規作成`;
}

function currentLabel(name: string): string {
  return `${name} (このプロジェクト)`;
}

function minutesOf(counts: Counts): Minutes {
  return { w: counts.w, r: counts.r };
}

function isEmpty(counts: Counts): boolean {
  return counts.w + counts.r + counts.pages + counts.created === 0;
}

function message(...lines: string[]): IntegratedView {
  return { kind: "message", lines };
}
