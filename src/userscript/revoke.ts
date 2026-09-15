/**
 * この端末を失効させる (design §6「`GET /v1/revoke.gif` と全削除」、段階 8、Issue #79)。
 *
 * 1. IndexedDB の鍵を読み、その鍵で `/v1/revoke.gif` に署名して送る (署名する鍵と消す鍵は同じ)
 * 2. **サーバが消してから (もう無かったときも含む)、ローカルの鍵を消す。** 順を逆にすると、
 *    送れなかったときに鍵だけ失って失効できなくなる
 * 3. 以後この端末は未登録に戻る。記録は残り、サインインし直せばまた送れる
 *
 * **失効してもサーバの記録 (`daily` / `daybits` / `graphs`) は消えない。** 消すのは全データの削除 (段階 8 の残り)。
 */
import { buildRevokeUrl, readRevokeWidth } from "../shared/revoke.ts";
import { sign } from "../shared/sign.ts";
import type { ImageResult } from "./image.ts";
import type { DeviceStore } from "./keys.ts";
import { WORKER_ORIGIN } from "./worker-origin.ts";

export type RevokeOutcome =
  /** サーバの鍵を消し、この端末の鍵も消した (もともと無かったときも含む) */
  | "revoked"
  /** そもそも登録されていない */
  | "not-enrolled"
  /** 知らない版の鍵。触らない */
  | "newer"
  /** IndexedDB を開けない */
  | "storage"
  /** 鍵で署名できない */
  | "key-unusable"
  | "error"
  | "timeout"
  /** 応答の画像が取り決めと違う */
  | "unexpected"
  /** サーバは消したが、ローカルの鍵を消せなかった */
  | "local-failed";

export type RevokeDependencies = {
  readonly keys: Pick<DeviceStore, "read" | "clear">;
  readonly sendImage: (url: string) => Promise<ImageResult>;
  readonly now: () => Date;
};

export type Revoker = {
  /** この端末の登録を取り消す。 */
  revokeThisDevice(): Promise<RevokeOutcome>;
};

export function createRevoker(deps: RevokeDependencies): Revoker {
  return {
    async revokeThisDevice() {
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
        return "not-enrolled";
      }
      const { uid, kid, privateKey } = device.record;

      let url: string;
      try {
        url = await buildRevokeUrl(
          WORKER_ORIGIN,
          { uid, kid, target: kid, time: Math.floor(deps.now().getTime() / 1000) },
          (input) => sign(privateKey, input),
        );
      } catch {
        // 署名できない (Firefox で鍵を読み戻せない報告がある)。**例外のメッセージは出さない**
        return "key-unusable";
      }

      const result = await deps.sendImage(url);
      const outcome = result.kind === "loaded" ? readRevokeWidth(result.width) : undefined;
      if (outcome === undefined) {
        return result.kind === "timeout"
          ? "timeout"
          : result.kind === "error"
            ? "error"
            : "unexpected";
      }

      try {
        await deps.keys.clear();
      } catch {
        // サーバの鍵は消えている。この端末からはもう送れないが、鍵の残骸が残る
        return "local-failed";
      }
      return "revoked";
    },
  };
}

/** 失効の結果を利用者に見せる文言。 */
export const REVOKE_TEXT: Record<RevokeOutcome, string> = {
  revoked:
    "この端末の登録を取り消しました。記録は残ります。使い直すときはサインインし直してください。",
  "not-enrolled": "この端末はもともと登録されていません。",
  newer: "新しい版の cosense-grass が登録した鍵です。新しい版から取り消してください。",
  storage: "このブラウザの保存領域 (IndexedDB) を開けないので取り消せませんでした。",
  "key-unusable":
    "この端末の鍵で署名できないので取り消せませんでした。サインインし直すと新しい鍵になります。",
  // 4xx (窓の外・鍵が既に無い) も画像としては読めないので error になる
  error:
    "サーバに届かなかったか、断られたので取り消せませんでした。時間をおいてやり直してください。",
  timeout: "応答が無いので取り消せませんでした。時間をおいてやり直してください。",
  unexpected: "応答が想定と違うので取り消せませんでした。時間をおいてやり直してください。",
  "local-failed":
    "サーバの登録は取り消しましたが、このブラウザの鍵を消せませんでした。ページを開き直してやり直してください。",
};
