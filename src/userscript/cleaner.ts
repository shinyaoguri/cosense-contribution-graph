/**
 * このブラウザに残っている記録を消す (design §9、ADR-0018、Issue #88)。
 *
 * **サーバのデータはここからは消せない。** 全データの削除は管理のページ (`/account`) で行う。
 * 逆に localStorage はブラウザにしかないので、**ページからは消せない**。だから両方に口がある。
 *
 * - 消すのは**記録の 3 つのキー** (`bits` / `daily` / `sent`)。
 *   **設定 (`settings`) は残す** — read 計上の on/off は記録ではなく好みなので、消すと勝手に戻ってしまう
 * - **端末の鍵は消さない。** 登録を外すのは「この端末を切り離す」(`revoke.ts`) の仕事
 * - 消した後も、サーバに送信済みの記録は残る (`/account` から消す)
 */
import { SENT_KEY } from "./outbox.ts";
import { BITS_KEY, DAILY_KEY } from "./store.ts";

/** 消す localStorage のキー。**設定は含めない。** */
export const CLEARED_KEYS = [BITS_KEY, DAILY_KEY, SENT_KEY] as const;

export type ClearResult =
  /** 消えた */
  | "cleared"
  /** 消しきれなかった (容量やプライベートモードの制限) */
  | "failed";

export type CleanerDependencies = {
  readonly storage: Pick<Storage, "removeItem">;
};

export type Cleaner = {
  /** このブラウザの記録を消す。 */
  clearLocalRecords(): ClearResult;
};

export function createCleaner(deps: CleanerDependencies): Cleaner {
  return {
    clearLocalRecords() {
      let ok = true;
      for (const key of CLEARED_KEYS) {
        try {
          deps.storage.removeItem(key);
        } catch {
          // 1 つ失敗しても残りは消す (途中で止めない)
          ok = false;
        }
      }
      return ok ? "cleared" : "failed";
    },
  };
}

/** 結果を利用者に見せる文言。 */
export const CLEAR_TEXT: Record<ClearResult, string> = {
  cleared:
    "このブラウザの記録を消しました。サーバに送った分は残っているので、消すときは管理のページから削除してください。",
  failed: "このブラウザの記録を消しきれませんでした。ページを開き直して、もう一度お試しください。",
};
