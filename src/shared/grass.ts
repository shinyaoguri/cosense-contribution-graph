/**
 * 図の形 (期間 × マス) と外寸 (ADR-0026 決定 1・2)。**Worker と UserScript の両方が読む。**
 *
 * Worker は外寸をここから取って描き (`src/worker/graph/grass.ts`)、UserScript は `<img>` の寸法をここから取る。
 * **`<img>` の寸法を手で書き写さない** (Issue #156・#202 で縦横比が崩れた)。
 */

/** 期間。半年 (26 週) か 1 年 (53 週) */
export type Span = "half" | "year";
/** マス。1 日を朝・昼・夜の 3 マスに分けるか、1 日を 1 マスにするか */
export type Cell = "slot" | "day";

export type GrassForm = { readonly span: Span; readonly cell: Cell };

export const SPANS: readonly Span[] = ["half", "year"];
export const CELLS: readonly Cell[] = ["slot", "day"];

/** 期間ごとの週数 */
export const SPAN_WEEKS: Record<Span, number> = { half: 26, year: 53 };

/**
 * 形ごとの外寸。モックを作者と見比べて決めた (Issue #220 の 2026-10-08 のコメント)。
 * **1 年の幅は 775 に収める** (870px では Cosense の本文の幅で縮む。design §8)
 */
export const GRASS_SIZES: Record<
  Span,
  Record<Cell, { readonly width: number; readonly height: number }>
> = {
  half: { slot: { width: 500, height: 400 }, day: { width: 500, height: 221 } },
  year: { slot: { width: 775, height: 361 }, day: { width: 775, height: 198 } },
};

/** `card.svg` の既定の形 (ADR-0024 のカード) */
export const CARD_FORM: GrassForm = { span: "half", cell: "slot" };
/** `{publicId}.svg` の既定の形 (貼ってある草の意味を保つ。ADR-0026 決定 6) */
export const GRAPH_FORM: GrassForm = { span: "year", cell: "day" };
