/**
 * 「草の設定」に何を出すかを決める (design §9「設定 UI」、段階 8、Issue #79)。
 * **DOM を触らない純粋な部分**で、描くのは `settings-dialog.ts` (`viewer.ts` と `graph-dialog.ts` の分け方と同じ)。
 *
 * - **サインインはここに集約する。** 未登録なら最初にこれを出す (design §9)。ページメニューからは外した
 * - 登録の状態は `sender.status()` から作る。**IndexedDB の読み方を 2 か所に書かない**
 * - **ほかの端末の一覧はここに出せない。** CSP に受信方向が無く、UserScript からサーバの `keys` を読めない
 *   (ADR-0001・0003)。出せるのはこの端末の kid と、その失効だけ。ほかの端末は Worker のサインイン済みページで扱う
 */
import type { SendStatus } from "./sender.ts";
import type { SettingsRead } from "./settings-store.ts";

export const SETTINGS_MENU_TITLE = "草の設定";

export const SETTINGS_DIALOG_TITLE = "cosense-grass: 草の設定";

type DeviceState =
  | {
      readonly kind: "enrolled";
      /** 端末の識別子。どの端末を失効させるかを見分けるために出す */
      readonly kid: string;
      readonly lines: readonly string[];
    }
  | { readonly kind: "not-enrolled"; readonly lines: readonly string[] }
  /** 登録の状態が読めない・この版では触らない */
  | { readonly kind: "message"; readonly lines: readonly string[] };

type CountReadState = {
  readonly value: boolean;
  /** 変えられるか。知らない版の設定があるときは変えない */
  readonly editable: boolean;
  readonly note?: string;
};

export type SettingsModel = {
  readonly device: DeviceState;
  readonly countRead: CountReadState;
  /** サインインのボタン。押しても直らない状態 (知らない版・保存領域が開けない) では出さない */
  readonly signIn?: { readonly label: string };
  /** この端末の失効。登録済みのときだけ出す */
  readonly revoke?: { readonly label: string; readonly confirm: string };
};

export const SIGN_IN_LABEL = "サインインしてこの端末を登録";

const SIGN_IN_AGAIN_LABEL = "サインインし直す";

export const COUNT_READ_LABEL = "読んだ時間も数える";

export const REVOKE_LABEL = "この端末の登録を取り消す";

export const REVOKE_CONFIRM =
  "この端末の登録を取り消します。これまでの記録は消えず、この端末からは送れなくなります。取り消しますか?";

export const COUNT_READ_NOTE =
  "off にすると、書いた時間だけを数えます。この設定はこのブラウザだけに効き、既に記録・送信したものは消えません。";

export function describeSettings(status: SendStatus, settings: SettingsRead): SettingsModel {
  return {
    device: describeDevice(status),
    countRead: {
      value: settings.settings.countRead,
      editable: !settings.newer,
      note: settings.newer
        ? "新しい版の cosense-grass が設定を書いているので、この版からは変えられません。新しい版を使ってください。"
        : undefined,
    },
    signIn: signInLabel(status),
    revoke:
      status.kind === "enrolled" ? { label: REVOKE_LABEL, confirm: REVOKE_CONFIRM } : undefined,
  };
}

function describeDevice(status: SendStatus): DeviceState {
  switch (status.kind) {
    case "enrolled":
      return {
        kind: "enrolled",
        kid: status.kid,
        lines: [
          "この端末は登録済みです。記録は同じ Google アカウントで登録したほかの端末とまとめられます。",
        ],
      };
    case "not-enrolled":
      return {
        kind: "not-enrolled",
        lines: [
          "この端末はまだ登録されていません。登録すると、このブラウザの記録を送り、ほかの端末と合わせた草が見られます。",
          "登録しなくても、このブラウザの中では草を数えて表示します。",
        ],
      };
    case "newer-key":
      return {
        kind: "message",
        lines: ["新しい版の cosense-grass が登録した鍵です。新しい版を使ってください。"],
      };
    case "newer-sent":
      return {
        kind: "message",
        lines: ["新しい版の cosense-grass が送信の記録を書いています。新しい版を使ってください。"],
      };
    case "storage":
      return {
        kind: "message",
        lines: [
          "このブラウザの保存領域 (IndexedDB) を開けないので、登録の状態が分かりません。ページを開き直してください。",
        ],
      };
  }
}

function signInLabel(status: SendStatus): { readonly label: string } | undefined {
  switch (status.kind) {
    case "enrolled":
      return { label: SIGN_IN_AGAIN_LABEL };
    case "not-enrolled":
      return { label: SIGN_IN_LABEL };
    default:
      return undefined;
  }
}
