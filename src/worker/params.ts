import { DEFAULT_PARAMS, MAX_WEEKS, type Params } from "./graph/grid.ts";
import { isSchemeName } from "./graph/scheme.ts";

const WEEKS_PATTERN = /^\d{1,2}$/;

/**
 * 描画パラメータをクエリから読む (design §6)。
 *
 * **不正な値と範囲外は既定値に落とす。** 画像として読まれるので、400 を返しても Cosense では
 * 壊れた画像になるだけで、何が悪いかは伝わらない。未知のキーは無視する。
 * どのプロジェクトを描くかはクエリで指定しない (URL の publicId が決める)。
 */
export function parseParams(search: URLSearchParams): Params {
  const theme = search.get("theme") === "dark" ? "dark" : DEFAULT_PARAMS.theme;
  const mode = search.get("mode") === "write" ? "write" : DEFAULT_PARAMS.mode;
  const rawPalette = search.get("palette");
  const palette = isSchemeName(rawPalette) ? rawPalette : DEFAULT_PARAMS.palette;

  // parseInt("10abc") は 10 になるので、先に形を見る
  const raw = search.get("weeks");
  let weeks = DEFAULT_PARAMS.weeks;
  if (raw !== null && WEEKS_PATTERN.test(raw)) {
    const n = Number(raw);
    if (n >= 1 && n <= MAX_WEEKS) {
      weeks = n;
    }
  }

  return { theme, weeks, mode, palette };
}
