/**
 * ページメニューのボタンのアイコン (Issue #122)。
 *
 * `scrapbox.PageMenu.addMenu` の `image` に渡す **data: URI の SVG** を作る。
 * Cosense の CSP は `img-src * data: blob:` (research §1) なので、外部へ取りに行かずに描ける。
 * **Worker にも Gyazo にも依存しない**ので、オフラインでも読み込みの遅延でも絵が欠けない。
 *
 * 絵は**草のマス目** 3×3。3 つの状態を、塗りの有無と色で見分ける。
 *
 * - `not-installed` … 点線の枠だけ。design §9 の「点線は計測開始前」と同じ使い方
 * - `local-only` … グレーで塗る (数えているが、このブラウザにしか記録が無い)
 * - `synced` … 紫で塗る (送っている)
 * - `unknown` … 判定が済むまでの暫定。`local-only` と同じ絵にして、ちらつかせない
 *
 * **`src/worker/graph/` を import しない。** 色は値でコピーする
 * (`scripts/build-userscript.mjs` が Worker のコードの混入でビルドを落とす。ADR-0019)。
 * **ライトとダークで色を変えない** — Cosense のテーマはブラウザの `prefers-color-scheme` と
 * 独立しているので、どちらの背景でも見える中間の明度を選ぶ。
 */
import type { SendStatus } from "./sender.ts";
import type { CountingStatus } from "./sensor.ts";

/** ボタンのアイコンが示す状態。 */
export type MenuState = "unknown" | "not-installed" | "local-only" | "synced";

/** マスの 1 辺と間隔 (viewBox の単位)。`3 * 5 + 2 * 1.5 + 2 * 1 = 20`。 */
const CELL = 5;
const GAP = 1.5;
const MARGIN = 1;
const SIZE = 20;

/**
 * マスの濃さ (0 が薄い)。**9 マスすべてを塗らない** — 均一に埋めると「草」ではなく単なる格子に見える。
 * 濃淡を散らして、活動の記録らしさを出す。
 */
const LEVELS = [1, 3, 0, 2, 3, 1, 0, 2, 2] as const;

/** 紫は既定の配色 (blue-pink) の violet の light 段から取った値 (design §7)。 */
const SYNCED = ["#ddd6fe", "#a78bfa", "#7c3aed", "#5b21b6"] as const;

/** 未サインインのグレー。同じ明度の階段にして、色だけが違って見えるようにする。 */
const LOCAL = ["#d8dee4", "#afb8c1", "#8b949e", "#6e7781"] as const;

/** 点線の枠の色。ライトでもダークでも沈まない中間の明度。 */
const OUTLINE = "#8b949e";

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
  return `data:image/svg+xml,${encodeURIComponent(svgOf(state))}`;
}

function svgOf(state: MenuState): string {
  const cells = LEVELS.map((level, index) => cell(state, level, index)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">${cells}</svg>`;
}

function cell(state: MenuState, level: number, index: number): string {
  const x = MARGIN + (index % 3) * (CELL + GAP);
  const y = MARGIN + Math.floor(index / 3) * (CELL + GAP);
  const box = `x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="1"`;
  if (state === "not-installed") {
    // **塗らず、点線の枠だけ。** 「ボタンは出ているが、このプロジェクトでは数えていない」
    return `<rect ${box} fill="none" stroke="${OUTLINE}" stroke-width="1" stroke-dasharray="2 1.5"/>`;
  }
  const palette = state === "synced" ? SYNCED : LOCAL;
  return `<rect ${box} fill="${palette[level] ?? palette[0]}"/>`;
}
