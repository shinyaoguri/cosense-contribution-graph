/**
 * 配色の差し替え口 (design §7)。
 *
 * **スキームは「Level・バランス・合計分数・テーマ」を受け取って色を返すだけの純粋な部品。**
 * 描画側 (Worker の SVG、段階 8 の DOM 注入) はスキームの中身を知らない。
 *
 * 配色を足すときは次の 2 通りのどちらかで作り、下の `SCHEMES` に 1 行足す。
 * - **色を変えたいだけ** なら、`bandScheme()` に 16 進の表を渡す (`blue-pink` がこれ)
 * - **規則で色を計算したい** なら、`ColorScheme` を直接実装する (`blue-yellow` がこれ)
 *
 * 足したスキームは `test/shared/scheme.test.ts` の契約テストに自動で通される。
 * 両 lib で型検査され、両環境でテストされる。
 */
import type { Level } from "./scale.ts";
import { bluePink } from "./schemes/blue-pink.ts";
import { blueYellow } from "./schemes/blue-yellow.ts";

export type Theme = "light" | "dark";

export type CellInput = {
  readonly level: Level;
  /** -1 (読み寄り) .. +1 (書き寄り)。描画側が中心から計算して渡す。write モードでは 0。 */
  readonly balance: number;
  /** 合計分数。凡例のマスは `Infinity` を渡す (彩度を飽和させる配色のため)。 */
  readonly total: number;
};

export interface ColorScheme {
  readonly name: string;
  /** マスの色 (`#rrggbb`)。 */
  cell(input: CellInput, theme: Theme): string;
  /** 凡例の列ごとのバランスの見本 (読 → 書)。描画側はこの数だけ列を並べる。 */
  readonly legendBalances: readonly number[];
}

export const SCHEMES = {
  "blue-pink": bluePink,
  "blue-yellow": blueYellow,
} as const satisfies Record<string, ColorScheme>;

export type SchemeName = keyof typeof SCHEMES;

export const DEFAULT_SCHEME: SchemeName = "blue-pink";

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
