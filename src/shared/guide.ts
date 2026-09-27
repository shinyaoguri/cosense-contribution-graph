/**
 * 草のダイアログの説明に添える図の名前と寸法 (Issue #182)。**描くのは Worker** (`src/worker/guide-svg.ts`。ADR-0019)。
 *
 * UserScript は `<img>` の幅と高さを先に確保するので、**寸法は両側でここを読む** (ずれると図の縦横比が崩れる)。
 */
export const GUIDE_WIDTH = 640;

export const GUIDE_HEIGHTS = {
  minutes: 210,
  grass: 296,
  overview: 290,
} as const;

export type GuideName = keyof typeof GUIDE_HEIGHTS;

export const GUIDE_NAMES = Object.keys(GUIDE_HEIGHTS) as readonly GuideName[];

export function isGuideName(value: string): value is GuideName {
  return Object.hasOwn(GUIDE_HEIGHTS, value);
}
