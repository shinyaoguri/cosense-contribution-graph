/**
 * 草のダイアログに並べる草を決める (design §9「表示」、段階 8、Issue #73)。**DOM を触らない純粋な部分**で、描くのは `graph-dialog.ts`。
 *
 * **草を描くのは Worker だけ** (ADR-0019、Issue #109)。ここが決めるのは、どの共有 SVG を
 * どの見出しで並べるかと、同期の状態の文言だけ。**このブラウザの記録から草を描くことはしない**。
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
 * - **未登録なら草は 1 枚も出ない。** 登録するまでサーバに記録が無いので、案内だけを返す (ADR-0019)
 */
import { MAX_TODAY_SENDS, type SentRecord, type Trigger } from "./outbox.ts";
import type { SendStatus } from "./sender.ts";
import { SETTINGS_LABEL, SIGN_IN_LABEL } from "./settings.ts";
import { localClock, localDay } from "./time.ts";

/** 最初に出すプロジェクト別の草の数。統合の方は、開くたびの Worker へのリクエストと D1 の読み取りを抑える */
export const INITIAL_PROJECT_GRAPHS = 5;

export type GraphEntry = {
  readonly label: string;
  readonly url: string;
  /** 活動の概観 (ADR-0021)。草の下に並べる */
  readonly overviewUrl: string;
  /** 日ごとの集計値の JSON (ADR-0020)。**渡すと内訳まで読める** */
  readonly dataUrl: string;
  /**
   * このブラウザから 1 件でも送れたか。false なら草はまだ無いかもしれない (ほかの端末から送っていればある)。
   * ~~押されるまで画像を読まない~~ **2026-09-24 から最初から読み**、読めなかったときの文言の言い分けにだけ使う
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
    // **未登録では草が 1 枚も出ない** (ADR-0019)。草はサーバが描くので、送る前は見るものが無い。
    // 活動はもう数えているので、「まだ何も始まっていない」と読まれないように書く
    case "not-enrolled":
      return message(
        "草を見るには、この端末を登録してください。",
        "活動はすでに数えていて、登録すると直近 30 日分の記録から送られます。",
        `このダイアログの下の「${SETTINGS_LABEL}」→「${SIGN_IN_LABEL}」から登録できます。`,
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
        total: {
          label: TOTAL_LABEL,
          url: status.graphUrl,
          overviewUrl: status.overviewUrl,
          dataUrl: status.dataUrl,
          sent: status.totalSent,
        },
        projects: [
          ...current.map((project) => ({
            label: currentLabel(project.name),
            url: project.graphUrl,
            overviewUrl: project.overviewUrl,
            dataUrl: project.dataUrl,
            sent: project.sent,
          })),
          ...others.map((project) => ({
            label: project.name,
            url: project.graphUrl,
            overviewUrl: project.overviewUrl,
            dataUrl: project.dataUrl,
            sent: project.sent,
          })),
        ],
      };
    }
  }
}

function currentLabel(name: string): string {
  return `${name} (このプロジェクト)`;
}

function message(...lines: string[]): IntegratedView {
  return { kind: "message", lines };
}
