/**
 * 図の間で共有する見た目の部品 (design §8)。文字の並び・文字色・計測開始前の枠の色と、合算の印。
 *
 * 草 (`layout.ts`)・カード (`grass.ts`)・概観 (`overview.ts`)・説明の図 (`guide-svg.ts`) が使う。
 * もとは草の `layout.ts` にあったが、草を 1 つの描画にまとめる (ADR-0026) ときに草と一緒に消えないよう切り出した。
 */
import type { ColorScheme, Theme } from "./scheme.ts";

export type Swatch = { readonly x: number; readonly y: number; readonly fill: string };

// 外部フォントは読めないので OS の日本語フォントを並べる。CJK フォントの無い環境では文字化けする
export const FONT_FAMILY =
  "'Hiragino Sans','Hiragino Kaku Gothic ProN','Noto Sans CJK JP','Yu Gothic',Meiryo,sans-serif";

// 背景は両テーマとも透明。埋め込み側がテーマを選ぶ前提で、文字色だけ変える
export const TEXT_COLOR: Record<Theme, string> = { light: "#57606a", dark: "#9198a1" };

/** 計測開始前のマスの枠 (design §8)。文字色より薄くして、記録のあるマスと取り違えないようにする */
export const MUTED_COLOR: Record<Theme, string> = { light: "#d0d7de", dark: "#3d444d" };

/**
 * 合算の印 (2026-09-24)。一辺 `MARK_CELL` のマスを `MARK_OFFSET` ずつずらして 3 枚重ねる。
 * **全体の一辺は草の格子のマス (11px) と同じ**にして、凡例の行の高さに収める
 */
export const MARK_CELL = 7;
const MARK_OFFSET = 2;
export const MARK_SIZE = MARK_CELL + MARK_OFFSET * 2;
/** マスが格子より小さいので、丸みも小さくする */
export const MARK_RADIUS = 1.5;
/** 印を塗る Level。奥ほど薄く、手前ほど濃い。**白の縁取りは使わない** (ダークで浮く)。濃淡の差で重なりを見せる */
const MARK_LEVELS = [1, 2, 3] as const;
/** 印のバランス。草の凡例の量の帯と同じく、中央の列 (読みと書きが半々) の色で濃淡だけを見せる */
const MARK_BALANCE = 0;

/**
 * 合算の印 (2026-09-24)。**マスを 3 枚ずらして重ね、「複数の草を束ねた草」を絵で示す。**
 * 奥 (右上) を薄く、手前 (左下) を濃く。色はスキームから量の帯と同じ取り方 (バランス 0) で取るので、
 * 配色とテーマに追従する。`(x, y)` は印の左上。草とカードの図の合算の印は、どちらもこれを使う
 */
export function layoutMark(scheme: ColorScheme, theme: Theme, x: number, y: number): Swatch[] {
  return MARK_LEVELS.map((level, i) => {
    const depth = MARK_LEVELS.length - 1 - i;
    return {
      x: x + depth * MARK_OFFSET,
      y: y + i * MARK_OFFSET,
      fill: scheme.cell({ level, balance: MARK_BALANCE }, theme),
    };
  });
}
