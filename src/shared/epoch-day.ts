/**
 * 日付を 1970-01-01 からの通し日数として扱う (design §8)。
 *
 * **日付は UTC だけで計算する。** workerd は常に UTC だが、jsdom はテストを走らせるマシンの
 * タイムゾーンで動く (手元は JST)。ローカル時刻の API を使うと両環境で結果がずれ、しかも CI は
 * 両方 UTC なので食い違いを検出できない。日は `"YYYY-MM-DD"` の文字列で受け取り、
 * `Date.UTC` と `getUTCDay` だけで扱う。
 *
 * **両 lib で型検査され、両環境でテストされる。** 送る側 (UserScript の `store.ts`・`outbox.ts`) と
 * 読む側 (Worker の `days.ts`・`graph-data.ts`) が同じ日を指すことが、記録が正しく重なる前提になる。
 *
 * ブラウザのローカル時刻から「今日」を決めるのは `src/userscript/time.ts`。ここは文字列と通し日数の間だけを扱う。
 */

const MS_PER_DAY = 86_400_000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `"YYYY-MM-DD"` を 1970-01-01 からの通し日数にする。 */
export function toEpochDay(day: string): number {
  const match = DAY_PATTERN.exec(day);
  if (!match) {
    throw new RangeError(`日付は YYYY-MM-DD で渡す: ${day}`);
  }
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / MS_PER_DAY;
}

/** 通し日数を `"YYYY-MM-DD"` にする。 */
export function fromEpochDay(epochDay: number): string {
  return new Date(epochDay * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * 曜日。0 = 日曜 .. 6 = 土曜。
 *
 * **呼ぶのは Worker の格子 (`src/worker/graph/grid.ts`) だけだが、ここに置く。**
 * タイムゾーンに依らないことの検証を jsdom でも走らせたいので、両環境で走る `test/shared/` に
 * テストを残している (ADR-0019 の移設で描画は worker へ移ったが、これは日付の性質の話)。
 */
export function weekdayOf(epochDay: number): number {
  return new Date(epochDay * MS_PER_DAY).getUTCDay();
}
