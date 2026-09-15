/**
 * 草のダイアログに並べる草を決める (design §9「表示」、段階 8、Issue #73)。**DOM を触らない純粋な部分**で、描くのは `graph-dialog.ts`。
 *
 * **統合の草が主で、このブラウザの記録は内訳** (Issue #101)。ダイアログは統合の草を先に出し、
 * ローカルの草は畳んだ中に置く。**同じ形の草を対等に 2 つ並べない** (どちらが本当か読めない)。
 *
 * **同期の状態** (`describeSync`)
 * - 分かるのは「このブラウザから送信済みか」だけ。**サーバには問い合わせられない** (CSP に受信方向が無い。ADR-0001)
 * - **前日以前と今日を分ける** (Issue #102)。今日を送るのはタブを隠したときと登録直後だけなので、
 *   開いた瞬間の今日はほぼ常に未送信。混ぜると開くたびに「未送信あり」が出て、警告が効かなくなる
 * - **`last` は「最後に送った」ではなく「最後に試した」。** `outcome` で言い分ける
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
 * - **計測開始 = 記録のある最も古い日** (Issue #80)。集計値は 371 日で消えるので、
 *   正確には「このブラウザに記録の残っている最初の日」。プロジェクト別も合算の開始日で塗り分ける
 *   (そのプロジェクトを使い始めた日ではなく、計測していなかった期間を示すため)
 */
import { centerOf, type Minutes } from "../shared/balance.ts";
import { DAYS, DEFAULT_PARAMS, fromEpochDay, MAX_WEEKS, toEpochDay } from "../shared/graph.ts";
import type { GraphInput } from "../shared/graph-layout.ts";
import { buildScale } from "../shared/scale.ts";
import { MAX_TODAY_SENDS, type SentRecord, type Trigger } from "./outbox.ts";
import type { SendStatus } from "./sender.ts";
import { SETTINGS_LABEL, SIGN_IN_LABEL } from "./settings.ts";
import { type Counts, DAILY_DAYS, type DayView } from "./store.ts";
import { localClock, localDay } from "./time.ts";

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

/** 統合の草に、このブラウザの記録が入っているか (Issue #102) */
export type SyncView = {
  readonly lines: readonly string[];
  /** 「今すぐ送る」を押せるか。**押せない理由は `lines` の中にある** */
  readonly canSend: boolean;
};

export type IntegratedView =
  | { readonly kind: "message"; readonly lines: readonly string[] }
  | {
      readonly kind: "graphs";
      readonly total: GraphEntry;
      /** 今のプロジェクトが先頭 (記録があれば) */
      readonly projects: readonly GraphEntry[];
      readonly sync: SyncView;
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

export const SEND_NOW_LABEL = "今すぐ送る";

/** **押す必要が普段ないことを言う。** これが読めれば「今すぐ送る」は非常用だと分かる */
export const AUTO_SEND_NOTE =
  "ページを開いたとき・日付が変わったとき・タブを離れたときに自動で送ります。";

const TRIGGER_TEXT: Record<Trigger, string> = {
  load: "ページを開いたとき",
  "day-change": "日付が変わったとき",
  hidden: "タブを離れたとき",
  enrolled: "端末を登録したとき",
  manual: `「${SEND_NOW_LABEL}」`,
};

export const TOTAL_LABEL = "合算 (UserScript を入れた全プロジェクト)";

export const LOCAL_TOTAL_LABEL = "合算 (このブラウザで数えた全プロジェクト)";

/** このブラウザの草で読む日数。草は 53 週を描き、四分位の母集団は集計値を持つ 371 日ぶん */
const LOCAL_DAYS = DAILY_DAYS;

/**
 * 統合の草に、このブラウザの記録が入っているか。`now` は「最後に送った」の書き方を決めるのに使う。
 */
export function describeSync(status: SendStatus, now: Date): SyncView {
  if (status.kind !== "enrolled") {
    return { lines: ["この端末からは記録を送れません。"], canSend: false };
  }
  const limited = status.todaySends >= MAX_TODAY_SENDS;
  const lines = [
    status.pendingPastDays > 0
      ? `まだ送れていない記録が ${status.pendingPastDays} 日分あります。`
      : "このブラウザの記録は送信済みです。",
    !status.todayPending
      ? "今日の分も送信済みです。"
      : limited
        ? `今日の分は送信の上限 (1 日 ${MAX_TODAY_SENDS} 回) に達したので、次にページを開いたときに送られます。`
        : "今日の分はまだ送っていません (タブを離れると自動で送ります)。",
  ];
  const last = lastLine(status.last, now);
  if (last !== undefined) {
    lines.push(last);
  }
  if (status.backoffUntil !== undefined) {
    lines.push(
      `続けて送信に失敗したので、自動の送信を ${stamp(new Date(status.backoffUntil), now)} まで止めています。「${SEND_NOW_LABEL}」はすぐ試します。`,
    );
  }
  lines.push(AUTO_SEND_NOTE);
  // **上限だけで塞がない。** 上限に達していても、前日以前の未送信は送れる
  return { lines, canSend: status.pendingPastDays > 0 || (status.todayPending && !limited) };
}

/** `last` は結果を問わず書かれるので、送れたときと試しただけのときを言い分ける */
function lastLine(last: SentRecord["last"], now: Date): string | undefined {
  if (last === undefined) {
    return undefined;
  }
  const at = stamp(new Date(last.at), now);
  if (last.outcome === "written" || last.outcome === "unchanged") {
    return `最後に送ったのは ${at} (${TRIGGER_TEXT[last.trigger] ?? "自動"})。`;
  }
  return `最後に試したのは ${at} ですが、送れませんでした。`;
}

/** 今日なら時刻だけ、別の日なら日付も (「14:32」だけだと昨日か今日か分からない) */
function stamp(at: Date, now: Date): string {
  const clock = localClock(at);
  return localDay(at) === localDay(now) ? clock : `${at.getMonth() + 1}/${at.getDate()} ${clock}`;
}

export function describeIntegrated(
  status: SendStatus,
  currentProject: string,
  now: Date,
): IntegratedView {
  switch (status.kind) {
    case "not-enrolled":
      return message(
        "この端末は未登録なので、全端末を統合した草はまだ見られません。",
        `このダイアログの下の「${SETTINGS_LABEL}」→「${SIGN_IN_LABEL}」から登録してください。`,
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
        sync: describeSync(status, now),
        // **合算も送れたかを見る** (Issue #100)。登録しただけで 1 件も送っていないと 404 になる
        total: { label: TOTAL_LABEL, url: status.graphUrl, sent: status.totalSent },
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

  // 記録のある最も古い日。表示範囲の外にあってもよい (その場合は印が出ない)
  const startDay = [...days.keys()].reduce<string | undefined>(
    (oldest, day) => (oldest === undefined || day < oldest ? day : oldest),
    undefined,
  );

  const graph = (label: string, counts: ReadonlyMap<string, Counts>): LocalGraph => ({
    label,
    counts,
    input: {
      today,
      days: new Map([...counts].map(([day, value]) => [day, minutesOf(value)])),
      scale,
      center,
      startDay,
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
