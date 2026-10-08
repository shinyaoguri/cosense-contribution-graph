import { fromEpochDay, toEpochDay } from "../shared/epoch-day.ts";
import { CELLS, type Cell, type GrassForm, SPANS, type Span } from "../shared/grass.ts";
import { isValidProjectName, isValidUserName } from "../shared/project-name.ts";
import type { Lang, Mode } from "./graph/grass.ts";
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

/**
 * 画像に描くユーザー名 (`?u=`。Issue #134)。`parseLabel` と同じく**サーバは保存しない**。
 * `isValidUserName` を通ったものだけ返し、外れていれば `undefined` (描かないだけ)。
 * **形はプロジェクト名よりずっと広く、`<` `&` `"` も通る** (Issue #195)。描くときの `escapeXml` が塞ぐ
 */
export function parseUser(search: URLSearchParams): string | undefined {
  const raw = search.get("u");
  return raw !== null && isValidUserName(raw) ? raw : undefined;
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

/**
 * カードの図のラベルの言語 (`?lang=`。ADR-0024)。**`en` のときだけ英語で、それ以外は日本語** (未知の値も 400 にしない)。
 */
function parseLang(search: URLSearchParams): Lang {
  return search.get("lang") === "en" ? "en" : "ja";
}

/** 図 (`card.svg`) の描画パラメータ (ADR-0026 決定 1)。 */
export type GrassParams = {
  readonly form: GrassForm;
  readonly theme: "light" | "dark";
  readonly mode: Mode;
  readonly palette: Params["palette"];
  readonly lang: Lang;
  /** `?year=` の年の 12/31。今日より後かどうかは描く側が見る */
  readonly end?: string;
};

const isSpan = (value: string | null): value is Span => SPANS.some((span) => span === value);
const isCell = (value: string | null): value is Cell => CELLS.some((cell) => cell === value);

/**
 * 図の描画パラメータをクエリから読む (ADR-0026 決定 1)。**既定の形は URL ごとに違う**ので呼び出し側が渡す (決定 6)。
 *
 * - `span` (`half` / `year`) と `cell` (`slot` / `day`) は独立に選べる。外れた値は既定に落とす (400 にしない)
 * - **`year` があれば、`span` によらず 1 年にする** (年を振り返るのに半年では足りない)
 * - `weeks` は読まない (期間は 2 つに絞った。未知のキーと同じく無視する)
 */
export function parseGrassParams(search: URLSearchParams, defaults: GrassForm): GrassParams {
  const { theme, mode, palette } = parseParams(search);
  const end = parseYear(search);
  const span = search.get("span");
  const cell = search.get("cell");
  return {
    form: {
      span: end !== undefined ? "year" : isSpan(span) ? span : defaults.span,
      cell: isCell(cell) ? cell : defaults.cell,
    },
    theme,
    mode,
    palette,
    lang: parseLang(search),
    ...(end === undefined ? {} : { end }),
  };
}
