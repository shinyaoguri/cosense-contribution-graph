/**
 * OKLCH から sRGB への変換と、ガモット外の色を彩度の二分探索で詰める処理。
 *
 * **使うのは Worker だけ** (ADR-0019)。草を描くのはサーバなので、色の計算もサーバにだけある。
 *
 * `oklch()` の CSS 記法は使わない。`<img>` 経由の SVG ではブラウザ依存が読めないので、
 * ここで 16 進数に焼き込む (design §7)。
 */

export type Vec3 = readonly [number, number, number];
type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

// 係数は CSS Color 4 の conversions.js と同じ (W3C)。design §7 が「CSS Color 4 の固定行列」と
// 指定しているのに合わせた。Ottosson の直接行列とは最大 5.5e-8 ずれるので、突き合わせの
// リファレンス (@csstools/color-helpers、同じ係数) と許容誤差 1e-12 で一致させるにはこちらが要る
const OKLAB_TO_LMS: Mat3 = [
  1, 0.3963377773761749, 0.2158037573099136, 1, -0.1055613458156586, -0.0638541728258133, 1,
  -0.0894841775298119, -1.2914855480194092,
];
const LMS_TO_XYZ_D65: Mat3 = [
  1.2268798758459243, -0.5578149944602171, 0.2813910456659647, -0.0405757452148008,
  1.112286803280317, -0.0717110580655164, -0.0763729366746601, -0.4214933324022432,
  1.5869240198367816,
];
const XYZ_D65_TO_LINEAR_SRGB: Mat3 = [
  12831 / 3959,
  -329 / 214,
  -1974 / 3959,
  -851781 / 878810,
  1648619 / 878810,
  36519 / 878810,
  705 / 12673,
  -2585 / 12673,
  705 / 667,
];

function multiply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** OKLCH (L 0..1、C、H 度) を linear sRGB にする。ガモットは気にしない。 */
export function oklchToLinearSrgb(l: number, c: number, h: number): Vec3 {
  const rad = (h * Math.PI) / 180;
  const lms = multiply(OKLAB_TO_LMS, [l, c * Math.cos(rad), c * Math.sin(rad)]);
  const xyz = multiply(LMS_TO_XYZ_D65, [lms[0] ** 3, lms[1] ** 3, lms[2] ** 3]);
  return multiply(XYZ_D65_TO_LINEAR_SRGB, xyz);
}

/** sRGB の伝達関数。符号を保つ (リファレンスと同じ) ので、ガモット外の負の値も連続に扱える。 */
function gammaChannel(v: number): number {
  const sign = v < 0 ? -1 : 1;
  const abs = Math.abs(v);
  return abs > 0.0031308 ? sign * (1.055 * abs ** (1 / 2.4) - 0.055) : 12.92 * v;
}

/** linear sRGB をガンマ補正した sRGB にする。値はクランプしない。 */
function linearToSrgb(rgb: Vec3): Vec3 {
  return [gammaChannel(rgb[0]), gammaChannel(rgb[1]), gammaChannel(rgb[2])];
}

/** OKLCH を sRGB (0..1、クランプなし) にする。 */
export function oklchToSrgb(l: number, c: number, h: number): Vec3 {
  return linearToSrgb(oklchToLinearSrgb(l, c, h));
}

// 浮動小数の誤差でわずかにはみ出す値をガモット外と誤判定しないための幅。
// 彩度 1e-6 の変化がチャネルを 1e-6 程度動かすので、それより十分小さく取る
const GAMUT_EPSILON = 1e-9;

/** linear sRGB の各チャネルが [0, 1] に収まっているか。 */
export function inSrgbGamut(linear: Vec3): boolean {
  return linear.every((v) => v >= -GAMUT_EPSILON && v <= 1 + GAMUT_EPSILON);
}

// 区間幅は C / 2^24。C = 0.145 で 8.6e-9 まで詰まり、16 進の 1 段 (1/255) よりはるかに細かい
const BISECTION_STEPS = 24;

/**
 * L と H を固定したまま、sRGB のガモットに収まる最大の彩度を返す。
 *
 * **要求した彩度がガモット内ならそのまま返す。** 二分探索に回すと 8.6e-9 だけ小さくなり、
 * ガモット内の色が完全には一致しなくなる。
 *
 * 二分探索が成り立つには「C を増やしてガモット外に出たら戻らない」必要がある。
 * ランプの L と色相 75〜235° の全域で、境界をまたぐのは高々 1 回だと確かめてある。
 * 実際に削られるのは全部下限側 (R か B が負) で、最悪は L = 0.50・色相 200° 付近。
 */
export function fitChroma(l: number, c: number, h: number): number {
  if (inSrgbGamut(oklchToLinearSrgb(l, c, h))) {
    return c;
  }
  // 下端 0 は必ずガモット内 (無彩色は 0 <= L <= 1 で [0, 1] に収まる)
  let lo = 0;
  let hi = c;
  for (let i = 0; i < BISECTION_STEPS; i++) {
    const mid = (lo + hi) / 2;
    if (inSrgbGamut(oklchToLinearSrgb(l, mid, h))) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** sRGB (0..1) を `#rrggbb` にする。**クランプしてから丸める。** */
export function srgbToHex(rgb: Vec3): string {
  const byte = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${byte(rgb[0])}${byte(rgb[1])}${byte(rgb[2])}`;
}

/** OKLCH をガモットに詰めてから `#rrggbb` にする。 */
export function oklchToHex(l: number, c: number, h: number): string {
  return srgbToHex(oklchToSrgb(l, fitChroma(l, c, h), h));
}
