/**
 * SVG に出す文字列をエスケープする。原則として全部通す (design §6)。
 *
 * 草・カード・概観・説明の図のどれも、外から来る文字列はここを通してから SVG に書く。
 *
 * **プロジェクト名 (`?l=`) とユーザー名 (`?u=`) だけは外から来る** (Issue #119・#134)。
 * プロジェクト名は `isValidProjectName` が英字・数字・ハイフンしか通さないので二重に塞ぐだけだが、
 * **ユーザー名は `<` `&` `"` も通す** (`isValidUserName`、Issue #195) ので、**ここが XSS を塞ぐ要点になる**。
 */
export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
