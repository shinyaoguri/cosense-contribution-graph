/**
 * クライアントのローカル時刻での日と分。**日の境界はクライアントのローカル日付で決める** (ADR-0002)。
 *
 * 分は design §4 の「ローカル時刻の 0:00 からの分」(0〜1439)。夏時間で同じ時刻が 2 回来ても、
 * ビットマップの OR なので同じ分に重なるだけで壊れない。
 */

/** ローカル時刻の `YYYY-MM-DD`。 */
export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** ローカル時刻の 0:00 からの分。 */
export function localMinute(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}
