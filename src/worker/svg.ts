/**
 * 草の SVG を組み立てる。
 *
 * **今は疎通確認のためのデモだけ。** 段階 1 の本体で OKLCH の配色・四分位のスケール・
 * 凡例をこの上に積む (docs/roadmap.md)。design §8 は**凡例を必須**としているので、
 * このデモは**まだその要件を満たさない**。
 *
 * `<img>` 経由で描画されるので完全に非インタラクティブで、外部フォントも外部 CSS も
 * 読めない。すべてインラインで自己完結させる (design §8)。
 */

/** 疎通確認用に予約した publicId。データを持たず、固定の草を返す。 */
export const DEMO_PUBLIC_ID = "demo";

/** 直近 53 週。列が週、行が曜日 (design §8)。 */
export const WEEKS = 53;
export const DAYS = 7;

// セルの寸法は design §8 の値。段階 1 の本体と同じ実寸にしておくと、
// Cosense の表示幅で縦横比や大きさが崩れないかを先に確かめられる
const CELL = 11;
const GAP = 3;
const PADDING = 8;

/**
 * 仮の配色。**OKLCH を通していない固定値**で、段階 1 の本体で置き換える。
 * 色は 16 進数で焼き込む。`oklch()` の CSS 記法は `<img>` 経由では
 * ブラウザ依存が読めないので使わない (design §7)。
 */
const PLACEHOLDER_LEVELS = ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"];

/**
 * デモの草を返す。
 *
 * **動的な文字列を一切出さない** (日付もラベルも無い) ので、ここではエスケープが要らない。
 * 文字列を出すようになる段階 1 でまとめて入れる (design §6)。
 */
export function renderDemoSvg(): string {
  const step = CELL + GAP;
  // width / height / viewBox の 3 つを必ず出す。欠けると Cosense でサイズが崩れる (design §8)
  const width = PADDING * 2 + WEEKS * step - GAP;
  const height = PADDING * 2 + DAYS * step - GAP;

  const cells: string[] = [];
  for (let week = 0; week < WEEKS; week++) {
    for (let day = 0; day < DAYS; day++) {
      const x = PADDING + week * step;
      const y = PADDING + day * step;
      cells.push(
        `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${demoColor(week, day)}"/>`,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${cells.join("")}</svg>`;
}

/** 週と曜日から決まる固定の色。テストで結果を固定できるよう乱数を使わない。 */
function demoColor(week: number, day: number): string {
  const level = (week * 7 + day * 3 + week * day) % PLACEHOLDER_LEVELS.length;
  return PLACEHOLDER_LEVELS[level] ?? "#ebedf0";
}
