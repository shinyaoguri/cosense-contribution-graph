/**
 * ページメニューのボタンのアイコン (Issue #122)。
 *
 * `scrapbox.PageMenu.addMenu` の `image` に渡す **data: URI の SVG** を作る。
 * Cosense の CSP は `img-src * data: blob:` (research §1) なので、外部へ取りに行かずに描ける。
 * **Worker にも Gyazo にも依存しない**ので、オフラインでも読み込みの遅延でも絵が欠けない。
 *
 * **絵そのものは `src/shared/grass-icon.ts` が作る** (Worker の favicon と同じ絵。Issue #130)。
 * ここは状態の判定と data: URI への変換だけを持つ。
 */
import { type GrassIconState, grassIconSvg } from "../shared/grass-icon.ts";
import type { SendStatus } from "./sender.ts";
import type { CountingStatus } from "./sensor.ts";

/** ボタンのアイコンが示す状態。絵の状態と 1 対 1 (`src/shared/grass-icon.ts`)。 */
export type MenuState = GrassIconState;

/**
 * センサーと送信の状況から、アイコンの状態を決める。
 *
 * - **数えていないことが最優先。** 送れる状態でも、このプロジェクトでは記録が増えない
 * - 送信の異常系 (`newer-key`・`newer-sent`・`storage`) は `unknown`。
 *   **`local-only` と言い切らない** — 登録済みなのに読めないだけのことがある
 */
export function describeMenuState(counting: CountingStatus, send: SendStatus): MenuState {
  if (counting === "not-installed") {
    return "not-installed";
  }
  if (counting === "checking") {
    return "unknown";
  }
  if (send.kind === "enrolled") {
    return "synced";
  }
  return send.kind === "not-enrolled" ? "local-only" : "unknown";
}

/** `addMenu` の `image` に渡す data: URI。 */
export function menuIcon(state: MenuState): string {
  return `data:image/svg+xml,${encodeURIComponent(grassIconSvg(state))}`;
}
