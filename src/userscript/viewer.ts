/**
 * 「草を見る」に並べる草を決める (design §9「表示」、段階 8、Issue #73)。**DOM を触らない純粋な部分**で、描くのは `graph-dialog.ts`。
 *
 * - 草の URL は `sender.status()` の値をそのまま使う。**publicId の導き方を 2 か所に書かない** (#72)
 * - 並べられるプロジェクトは、このブラウザで直近 30 日に記録したものだけ。サーバはプロジェクト名を持たないので、
 *   ほかの端末だけで使ったプロジェクトは名前が分からない (ADR-0007)
 * - 並びは合算、今のプロジェクト、残りは `status()` の順 (名前の順)
 */
import { SIGN_IN_MENU_TITLE } from "./auth.ts";
import type { SendStatus } from "./sender.ts";

export const VIEW_MENU_TITLE = "草を見る";

/** 最初に出すプロジェクト別の草の数。開くたびの Worker へのリクエストと D1 の読み取りを抑える */
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

export type ViewModel =
  | { readonly kind: "message"; readonly lines: readonly string[] }
  | {
      readonly kind: "graphs";
      readonly total: GraphEntry;
      /** 今のプロジェクトが先頭 (記録があれば) */
      readonly projects: readonly GraphEntry[];
    };

export const TOTAL_LABEL = "合算 (UserScript を入れた全プロジェクト)";

export function describeView(status: SendStatus, currentProject: string): ViewModel {
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
            label: `${project.name} (このプロジェクト)`,
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

function message(...lines: string[]): ViewModel {
  return { kind: "message", lines };
}
