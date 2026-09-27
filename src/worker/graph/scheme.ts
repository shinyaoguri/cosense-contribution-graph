/**
 * 配色の差し替え口 (design §7)。
 *
 * **スキームは「Level・バランス・テーマ」を受け取って色を返すだけの純粋な部品。**
 * 描画側 (`svg.ts` と `layout.ts`) はスキームの中身を知らない。
 *
 * 配色は今は `violet-amber` の 1 つだけ (ADR-0023)。足すときは `bandScheme()` に 16 進の表を渡し、
 * 下の `SCHEMES` に 1 行足す。規則で色を計算したいなら `ColorScheme` を直接実装してもよい。
 *
 * 足したスキームは `test/worker/graph/scheme.test.ts` の契約テストと、
 * `scheme-cvd.test.ts` の色覚のテストに自動で通される。
 * **使うのは Worker だけ** (ADR-0019)。
 */
import type { Level } from "./scale.ts";
import { violetAmber } from "./schemes/violet-amber.ts";

export type Theme = "light" | "dark";

export type CellInput = {
  readonly level: Level;
  /** -1 (読み寄り) .. +1 (書き寄り)。描画側が中心から計算して渡す。write モードでは 0。 */
  readonly balance: number;
};

export interface ColorScheme {
  readonly name: string;
  /** マスの色 (`#rrggbb`)。 */
  cell(input: CellInput, theme: Theme): string;
  /** 凡例の列ごとのバランスの見本 (読 → 書)。描画側はこの数だけ列を並べる。 */
  readonly legendBalances: readonly number[];
}

export const SCHEMES = {
  "violet-amber": violetAmber,
} as const satisfies Record<string, ColorScheme>;

export type SchemeName = keyof typeof SCHEMES;

export const DEFAULT_SCHEME: SchemeName = "violet-amber";

/**
 * クエリの値が登録済みのスキーム名か。
 *
 * **`Object.hasOwn` で見る。** `in` だと `toString` や `__proto__` のような継承したキーも通る。
 */
export function isSchemeName(value: string | null): value is SchemeName {
  return value !== null && Object.hasOwn(SCHEMES, value);
}

export function schemeOf(name: SchemeName): ColorScheme {
  return SCHEMES[name];
}
