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

const YEAR_PATTERN = /^\d{4}$/;

/**
 * 振り返る年 (`?year=`。Issue #128)。**その年の 12 月 31 日**を返す。
 *
 * **指定は年だけ。** 日付まで刻める必要がなく、年が分かれば「2025 年の草」として貼れる
 * (2026-09-18 に決めた)。返した日は呼び出し側が草の右端にし、**今日より後なら今日に落とす** —
 * 今年を指定したときは自然と「今日が右端」になる。
 *
 * **左端は厳密な 1 月 1 日にはならない。** 草は週単位の列で並ぶので、12/31 を右端に 53 週
 * (371 日) 遡ると前年の末尾が 5〜13 日ぶん入る。**1 月 1 日は必ず含まれる** (365 < 371)。
 * 週数を年ごとに変えると SVG の幅が変わり、`<img>` に寸法を固定している UserScript 側で絵が崩れる。
 *
 * 形が外れていれば `undefined` を返し、呼び出し側が今日を使う。ほかのクエリと同じく **400 にはしない**。
 */
export function parseYear(search: URLSearchParams): string | undefined {
  const raw = search.get("year");
  if (raw === null || !YEAR_PATTERN.test(raw)) {
    return undefined;
  }
  const lastDay = `${raw}-12-31`;
  // 4 桁ならここは必ず通るが、日付の組み立てが壊れていないことを往復で確かめる
  return fromEpochDay(toEpochDay(lastDay)) === lastDay ? lastDay : undefined;
}
