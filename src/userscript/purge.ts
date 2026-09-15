/**
 * 全データの削除 (design §6、privacy.md「データの削除」、段階 8、Issue #79)。
 *
 * 1. IndexedDB の鍵を読み、その鍵で `/v1/delete.gif` に署名して送る (`confirm=1` を含む)
 * 2. **サーバが消してから、このブラウザの記録と鍵を消す。** 順を逆にすると署名する鍵を失い、
 *    サーバのデータを消せなくなる
 * 3. **ローカルは、サーバに届かなくても消したい場合がある**ので、サーバ側の失敗とローカルの結果を分けて返す
 *
 * 消すのは localStorage の 4 つのキー (`bits` / `daily` / `sent` / `settings`) と IndexedDB の鍵。
 * **DB そのものは消さない** (`keys.ts` と同じ。別の版が置いた値に触らない)。
 */
import { buildPurgeUrl, readPurgeWidth } from "../shared/purge.ts";
import { sign } from "../shared/sign.ts";
import type { ImageResult } from "./image.ts";
import type { DeviceStore } from "./keys.ts";
import { SENT_KEY } from "./outbox.ts";
import { SETTINGS_KEY } from "./settings-store.ts";
import { BITS_KEY, DAILY_KEY } from "./store.ts";
import { WORKER_ORIGIN } from "./worker-origin.ts";

/** 消す localStorage のキー。 */
export const PURGED_KEYS = [BITS_KEY, DAILY_KEY, SENT_KEY, SETTINGS_KEY] as const;

export type PurgeResult =
  /** サーバもこのブラウザも消えた */
  | "purged"
  /** サーバは消えたが、このブラウザに消せないものが残った */
  | "local-failed"
  /** この端末は未登録。**サーバには何も無いので、このブラウザの記録だけ消した** */
  | "local-only"
  /** 知らない版の鍵。触らない */
  | "newer"
  /** IndexedDB を開けない */
  | "storage"
  /** 鍵で署名できない */
  | "key-unusable"
  | "error"
  | "timeout"
  /** 応答の画像が取り決めと違う */
  | "unexpected";

export type PurgeDependencies = {
  readonly keys: Pick<DeviceStore, "read" | "clear">;
  readonly storage: Pick<Storage, "removeItem">;
  readonly sendImage: (url: string) => Promise<ImageResult>;
  readonly now: () => Date;
};

export type Purger = {
  /** サーバとこのブラウザのデータを消す。 */
  purgeAll(): Promise<PurgeResult>;
};

export function createPurger(deps: PurgeDependencies): Purger {
  /** このブラウザの記録と鍵を消す。消しきれたか */
  async function clearLocal(withKey: boolean): Promise<boolean> {
    let ok = true;
    for (const key of PURGED_KEYS) {
      try {
        deps.storage.removeItem(key);
      } catch {
        ok = false;
      }
    }
    if (withKey) {
      try {
        await deps.keys.clear();
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  return {
    async purgeAll() {
      let device: Awaited<ReturnType<DeviceStore["read"]>>;
      try {
        device = await deps.keys.read();
      } catch {
        return "storage";
      }
      if (device.kind === "newer") {
        return "newer";
      }
      if (device.kind !== "found") {
        // 未登録なら送るものが無い。**このブラウザの記録は消す** (鍵は無い)
        return (await clearLocal(false)) ? "local-only" : "local-failed";
      }
      const { uid, kid, privateKey } = device.record;

      let url: string;
      try {
        url = await buildPurgeUrl(
          WORKER_ORIGIN,
          { uid, kid, time: Math.floor(deps.now().getTime() / 1000) },
          (input) => sign(privateKey, input),
        );
      } catch {
        // 署名できない (Firefox で鍵を読み戻せない報告がある)。**例外のメッセージは出さない**
        return "key-unusable";
      }

      const result = await deps.sendImage(url);
      const outcome = result.kind === "loaded" ? readPurgeWidth(result.width) : undefined;
      if (outcome === undefined) {
        return result.kind === "timeout"
          ? "timeout"
          : result.kind === "error"
            ? "error"
            : "unexpected";
      }

      return (await clearLocal(true)) ? "purged" : "local-failed";
    },
  };
}

/** 削除の結果を利用者に見せる文言。 */
export const PURGE_TEXT: Record<PurgeResult, string> = {
  purged:
    "サーバとこのブラウザのデータを削除しました。共有 URL の草も消えます。使い直すときはサインインし直してください。",
  "local-only":
    "この端末は未登録なので、サーバにはデータがありません。このブラウザの記録を削除しました。",
  "local-failed":
    "このブラウザのデータを消しきれませんでした。ページを開き直して、もう一度お試しください。",
  newer: "新しい版の cosense-grass が登録した鍵です。新しい版から削除してください。",
  storage: "このブラウザの保存領域 (IndexedDB) を開けないので削除できませんでした。",
  "key-unusable":
    "この端末の鍵で署名できないので削除できませんでした。サインインし直すと新しい鍵になります。",
  // 4xx (窓の外・鍵が無い) も画像としては読めないので error になる
  error:
    "サーバに届かなかったか、断られたので削除できませんでした。時間をおいてやり直してください。",
  timeout: "応答が無いので削除できませんでした。時間をおいてやり直してください。",
  unexpected: "応答が想定と違うので削除できませんでした。時間をおいてやり直してください。",
};
