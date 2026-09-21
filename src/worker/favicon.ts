/**
 * favicon (Issue #130)。**Cosense のページメニューのボタンと同じ絵** (`src/shared/grass-icon.ts`)。
 *
 * **data: URI にしない。** 各ページの CSP は `img-src 'self'` で、favicon の取得も `img-src` に従う。
 * CSP を緩めずに済むよう、同じオリジンのパスで配信する。
 *
 * **SVG だけを出す。** PNG や ICO を作るには Worker に画像のエンコーダを持ち込むことになり、釣り合わない。
 * SVG の favicon を読まないブラウザでは既定の絵になる。`/favicon.ico` は 404 のまま
 * (中身が SVG なのに `.ico` を名乗らせない)。
 */
import { grassIconSvg } from "../shared/grass-icon.ts";

export const FAVICON_PATH = "/favicon.svg";

/** 状態で変えない。Worker のページは「送っている」側なので、ボタンの `synced` (紫) を使う。 */
export const FAVICON_SVG = grassIconSvg("synced");

/** 各ページの `<head>` に入れる 1 行。 */
export const FAVICON_LINK = `<link rel="icon" href="${FAVICON_PATH}" type="image/svg+xml">`;

/** 絵が固定なので、草 (15 分) より長く持たせる。変えたときは ETag が変わる。 */
export const FAVICON_CACHE_CONTROL = "public, max-age=86400";
