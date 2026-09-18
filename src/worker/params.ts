import { fromEpochDay, toEpochDay } from "../shared/epoch-day.ts";
import { isValidProjectName } from "../shared/project-name.ts";
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

/**
 * 画像に描くプロジェクト名 (`?l=`。Issue #119、ADR-0007 決定 2 の再改訂)。
 *
 * **サーバは保存しない。** 描くときにだけ受け取り、`isValidProjectName` を通ったものだけ返す。
 * 形が外れていれば `undefined` — **描かないだけで 400 にはしない** (画像として読まれるので、
 * エラーにしても壊れた画像になるだけ。ほかのパラメータと同じ扱い)。
 */
export function parseLabel(search: URLSearchParams): string | undefined {
  const raw = search.get("l");
  return raw !== null && isValidProjectName(raw) ? raw : undefined;
}

/** `end` の形。実在しない日 (`2024-02-30`) は往復で弾く */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 草の右端にする日 (`?end=`。Issue #128)。
 *
 * **過去を振り返るためのもの。** 既定は今日で、それより後は受けない
 * (未来のマスを描いても意味がない)。形が外れていれば `undefined` を返し、
 * 呼び出し側が今日を使う。ほかのパラメータと同じく **400 にはしない**。
 */
export function parseEnd(search: URLSearchParams): string | undefined {
  const raw = search.get("end");
  if (raw === null || !DAY_PATTERN.test(raw)) {
    return undefined;
  }
  // 2024-02-30 のような存在しない日は、通し日数へ往復させると別の日になる
  const epochDay = toEpochDay(raw);
  return Number.isFinite(epochDay) && fromEpochDay(epochDay) === raw ? raw : undefined;
}
