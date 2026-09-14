/**
 * Google でサインインして、この端末の鍵を登録する (design §3「サインインのフロー」の手順 1・6)。
 *
 * 1. メニューを押した**同じ同期区間で** `/auth/start` をポップアップで開き、`message` を待ち始める
 *    (`await` を挟むと transient activation が失われ、ポップアップがブロックされる)
 * 2. 同時にダイアログを開き、**コードの貼り付け欄を最初から出す** (COOP で opener が切れたときのフォールバック。
 *    `window.prompt` は開いている間イベントループを止め、ポップアップからのメッセージを待たされるので使わない)
 * 3. ポップアップからのメッセージか貼り付けの、**最初に取れたコードで締める** (同じコードの 2 回目は Worker が 403 にする)
 * 4. 保存済みの鍵を読み、同じ uid なら使い回し、無ければ作る。登録する鍵で署名して `/v1/enroll.gif` を送る
 * 5. **登録できてから** IndexedDB に保存する
 *
 * **コード・uid・トークン・登録の URL はログにも例外にも出さない** (Cosense は例外を外部に集めうる)。
 */
import {
  AUTH_MESSAGE_TYPE,
  AUTH_START_PATH,
  type AuthCode,
  parseAuthCode,
} from "../shared/auth.ts";
import { buildEnrollUrl, readEnrollWidth } from "../shared/enroll.ts";
import { kidOf, PH_ALL, publicIdOf } from "../shared/ids.ts";
import { exportPublicKey, sign } from "../shared/sign.ts";
import type { ImageResult } from "./image.ts";
import type { DeviceRecord, DeviceStore } from "./keys.ts";
import { graphUrl, WORKER_ORIGIN } from "./worker-origin.ts";

export const SIGN_IN_MENU_TITLE = "草: サインインしてこの端末を登録";

/** 同じ名前で開けば、押し直したときに同じポップアップが使われる */
export const AUTH_POPUP_NAME = "cosense-grass-auth";
export const AUTH_POPUP_FEATURES = "popup,width=480,height=640";

type AuthFailure = "cancelled" | "expired" | "failed";

type Route = "popup" | "paste";

const FAILURE_TEXT: Record<AuthFailure, string> = {
  cancelled:
    "ポップアップでサインインが取り消されました。やり直すときはメニューをもう一度押してください。",
  expired: "サインインの有効期限が切れました。メニューをもう一度押してやり直してください。",
  failed:
    "ポップアップでサインインに失敗しました。時間をおいて、メニューをもう一度押してください。",
};

/** ダイアログ。DOM の実装は `sign-in-dialog.ts`、テストは偽物 */
export type SignInView = {
  open(
    state: { readonly popupBlocked: boolean; readonly startUrl: string },
    handlers: { submit(text: string): void; cancel(): void },
  ): void;
  status(text: string): void;
  busy(on: boolean): void;
  confirm(text: string): Promise<boolean>;
  finish(lines: readonly string[], link?: string): void;
  close(): void;
};

type MessageSource = {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

export type SignInDependencies = {
  /** `window.open`。ブロックされたら null */
  readonly openPopup: (url: string) => { close(): void } | null;
  readonly messages: MessageSource;
  readonly view: SignInView;
  readonly keys: DeviceStore;
  readonly generateKeyPair: () => Promise<CryptoKeyPair>;
  readonly sendImage: (url: string) => Promise<ImageResult>;
  readonly now: () => Date;
  /** 結果の種類だけを出す */
  readonly log: (message: string) => void;
};

export type SignInOutcome =
  | "added"
  | "known"
  | "cancelled"
  | "declined"
  | "rejected"
  | "timeout"
  | "unexpected"
  | "storage"
  | "newer"
  | "failed"
  | "busy";

/**
 * ポップアップからのメッセージを読む。**オリジンと送り元のウィンドウが合わないものは読まない**。
 * 形が違う・知らない版なら `undefined`。
 */
export function readAuthMessage(
  event: Pick<MessageEvent, "origin" | "source" | "data">,
  popup: unknown,
): { readonly code: AuthCode } | { readonly error: AuthFailure } | undefined {
  if (event.origin !== WORKER_ORIGIN || popup === null || event.source !== popup) {
    return undefined;
  }
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const message = data as Record<string, unknown>;
  if (message.type !== AUTH_MESSAGE_TYPE || message.v !== 1) {
    return undefined;
  }
  if (typeof message.code === "string") {
    const code = parseAuthCode(message.code);
    return code ? { code } : undefined;
  }
  if ("error" in message) {
    const { error } = message;
    return { error: error === "cancelled" || error === "expired" ? error : "failed" };
  }
  return undefined;
}

/**
 * メニューの onClick に渡す関数を作る。**返す関数は async にしない。** 先頭でポップアップを開き、
 * 同じ同期区間でリスナーを付ける (後から `await` を前に足されると壊れるので、テストで固定している)。
 */
export function createSignIn(deps: SignInDependencies): () => Promise<SignInOutcome> {
  let running = false;

  return () => {
    // dev と v1 のバンドルが両方読み込まれていても、流れは 1 本
    if (running) {
      return Promise.resolve("busy");
    }
    running = true;
    const startUrl = `${WORKER_ORIGIN}${AUTH_START_PATH}`;
    const popup = deps.openPopup(startUrl);

    const outcome = new Promise<SignInOutcome>((resolve) => {
      let taken = false;

      const release = () => {
        deps.messages.removeEventListener("message", onMessage);
        try {
          popup?.close();
        } catch {
          // COOP で切れていても何もしない
        }
      };
      const take = (code: AuthCode, route: Route) => {
        taken = true;
        release();
        deps.view.busy(true);
        void enroll(code, route, deps).then((result) => {
          deps.log(`[cosense-grass] サインイン: ${result.outcome}`);
          if (result.outcome === "declined") {
            deps.view.close();
          } else {
            deps.view.finish(result.lines, result.link);
          }
          resolve(result.outcome);
        });
      };
      function onMessage(event: MessageEvent) {
        if (taken) {
          return;
        }
        const read = readAuthMessage(event, popup);
        if (read === undefined) {
          return;
        }
        if ("error" in read) {
          // 貼り付けの経路は残す (別のタブで始めたサインインが cookie を上書きしたときも、こちらは expired になる)
          deps.view.status(FAILURE_TEXT[read.error]);
          return;
        }
        take(read.code, "popup");
      }

      if (popup !== null) {
        deps.messages.addEventListener("message", onMessage);
      }
      deps.view.open(
        { popupBlocked: popup === null, startUrl },
        {
          submit(text) {
            if (taken) {
              return;
            }
            const code = parseAuthCode(text);
            if (code === undefined) {
              deps.view.status(
                "コードの形が違います。サインインの画面に出た 48 文字をそのまま貼ってください。",
              );
              return;
            }
            take(code, "paste");
          },
          cancel() {
            deps.view.close();
            if (!taken) {
              taken = true;
              release();
              deps.log("[cosense-grass] サインイン: cancelled");
              resolve("cancelled");
            }
          },
        },
      );
    });
    return outcome.finally(() => {
      running = false;
    });
  };
}

type EnrollResult = {
  readonly outcome: SignInOutcome;
  readonly lines: readonly string[];
  readonly link?: string;
};

type SigningKey = {
  readonly privateKey: CryptoKey;
  readonly publicKey: Uint8Array<ArrayBuffer>;
  readonly kid: string;
};

/** コードを受け取った後。**例外を外に出さない** */
async function enroll(
  code: AuthCode,
  route: Route,
  deps: SignInDependencies,
): Promise<EnrollResult> {
  try {
    return await enrollUnsafe(code, route, deps);
  } catch {
    return {
      outcome: "failed",
      lines: ["登録の途中で失敗しました。メニューをもう一度押してやり直してください。"],
    };
  }
}

async function enrollUnsafe(
  code: AuthCode,
  route: Route,
  deps: SignInDependencies,
): Promise<EnrollResult> {
  // **保存済みの記録はコードを受け取ってから読む。** クリックの時点で読むと、その間に別のタブが保存した鍵を上書きしうる
  let read: Awaited<ReturnType<DeviceStore["read"]>>;
  try {
    read = await deps.keys.read();
  } catch {
    return {
      outcome: "storage",
      lines: [
        "このブラウザの保存領域 (IndexedDB) を開けませんでした。プライベートブラウズでは使えないことがあります。",
      ],
    };
  }
  if (read.kind === "newer") {
    return {
      outcome: "newer",
      lines: [
        "新しい版の cosense-grass がこの端末を登録しています。新しい版のメニューから操作してください。",
      ],
    };
  }

  let reuse: SigningKey | undefined;
  if (read.kind === "found") {
    if (read.record.uid === code.uid) {
      reuse = read.record;
    } else {
      deps.view.busy(false);
      const replace = await deps.view.confirm(
        "この端末は別の Google アカウントで登録されています。いまサインインしたアカウントで登録し直しますか？",
      );
      if (!replace) {
        return { outcome: "declined", lines: [] };
      }
      deps.view.busy(true);
    }
  }

  let attempt = await signedUrl(code, reuse, deps.generateKeyPair);
  if (attempt === undefined && reuse !== undefined) {
    // 保存した鍵で署名できない (Firefox に読み戻しの報告がある)。トークンはまだ使っていないので新しい鍵で送る
    reuse = undefined;
    attempt = await signedUrl(code, undefined, deps.generateKeyPair);
  }
  if (attempt === undefined) {
    return { outcome: "failed", lines: ["鍵を作れませんでした。"] };
  }
  const { key, url } = attempt;

  const result = await deps.sendImage(url);
  if (result.kind !== "loaded") {
    return {
      outcome: result.kind === "timeout" ? "timeout" : "rejected",
      lines:
        result.kind === "timeout"
          ? ["登録の応答がありませんでした。通信を確かめて、メニューをもう一度押してください。"]
          : [
              "登録できませんでした。コードの期限 (5 分) が切れたか、使用済みの可能性があります。",
              "メニューをもう一度押して、サインインからやり直してください。",
            ],
    };
  }
  const enrolled = readEnrollWidth(result.width);
  if (enrolled === undefined) {
    return {
      outcome: "unexpected",
      lines: [
        `登録の応答が想定と違いました (幅 ${result.width})。途中で別の画像に置き換えられている可能性があります。`,
      ],
    };
  }

  // **登録してから保存する。** 失敗したときに保存しておくと、使えない鍵が残る
  if (reuse === undefined) {
    const record: DeviceRecord = {
      v: 1,
      uid: code.uid,
      kid: key.kid,
      privateKey: key.privateKey,
      publicKey: key.publicKey,
      enrolledAt: deps.now().toISOString(),
    };
    try {
      await deps.keys.write(record);
    } catch {
      return {
        outcome: "storage",
        lines: [
          "登録はできましたが、このブラウザに鍵を保存できませんでした。メニューをもう一度押してください。",
        ],
      };
    }
  }

  return {
    outcome: enrolled.added ? "added" : "known",
    lines: [
      enrolled.added ? "この端末を新しく登録しました。" : "この端末は登録済みでした。",
      `受け取った経路: ${route === "popup" ? "ポップアップ" : "コードの貼り付け"}`,
      `端末の識別子 (kid): ${key.kid}`,
      "合算の草 (同じ Google アカウントなら、どの端末でも同じ URL になります):",
    ],
    link: graphUrl(await publicIdOf(code.uid, PH_ALL)),
  };
}

/**
 * 登録の URL を作る。`reuse` が無ければ新しい鍵ペアを作る。署名できなければ `undefined`。
 */
async function signedUrl(
  code: AuthCode,
  reuse: SigningKey | undefined,
  generateKeyPair: () => Promise<CryptoKeyPair>,
): Promise<{ key: SigningKey; url: string } | undefined> {
  try {
    let key = reuse;
    if (key === undefined) {
      const pair = await generateKeyPair();
      const publicKey = await exportPublicKey(pair.publicKey);
      key = { privateKey: pair.privateKey, publicKey, kid: await kidOf(publicKey) };
    }
    const signingKey = key.privateKey;
    const url = await buildEnrollUrl(
      WORKER_ORIGIN,
      { uid: code.uid, publicKey: key.publicKey, token: code.token },
      (input) => sign(signingKey, input),
    );
    return { key, url };
  } catch {
    return undefined;
  }
}
