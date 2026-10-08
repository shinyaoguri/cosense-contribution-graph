/**
 * Worker のページ (`/`・`/ja`・`/account`) に図を出す `<img>`。
 *
 * **寸法は外寸の表 (`GRASS_SIZES`) から取る。** `<img>` の寸法と図の外寸が違うと縦横比が崩れる (Issue #156・#202)。
 * 形はその URL が描く形 (経路の既定とクエリ) を呼び出し側が渡す。
 */
import { GRASS_SIZES, type GrassForm } from "../shared/grass.ts";

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

export function grassImage(src: string, form: GrassForm, alt: string): string {
  const { width, height } = GRASS_SIZES[form.span][form.cell];
  return `<img src="${escapeAttribute(src)}" width="${width}" height="${height}" alt="${escapeAttribute(alt)}">`;
}
