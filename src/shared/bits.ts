/**
 * 1 日分の分バケットのビットマップ (ADR-0002、design §4)。
 *
 * **1440 bit = 180 バイト。** 分 m (ローカル時刻の 0:00 からの分、0〜1439) は、
 * バイト `m >> 3` の **上位ビットから** 詰める (`0x80 >> (m & 7)`)。0:00 がバイト 0 の最上位、
 * 23:59 がバイト 179 の最下位。
 *
 * 集合演算なので冪等かつ順序に依らずマージできる。write と read の 2 枚を持ち、
 * 同じ分に両方あれば write を優先する (`r & ~w`)。
 *
 * 両 lib で型検査され、両環境でテストされる。
 */

export const MINUTES_PER_DAY = 1440;

export const BITMAP_BYTES = MINUTES_PER_DAY / 8;

export type Bitmap = Uint8Array<ArrayBuffer>;

/** 指定した分に bit を立てたビットマップ。範囲外の分は RangeError。 */
export function bitmapOf(minutes: Iterable<number>): Bitmap {
  const bitmap = new Uint8Array(BITMAP_BYTES);
  for (const minute of minutes) {
    if (!Number.isInteger(minute) || minute < 0 || minute >= MINUTES_PER_DAY) {
      throw new RangeError(`分は 0〜${MINUTES_PER_DAY - 1}: ${minute}`);
    }
    bitmap[minute >> 3] = (bitmap[minute >> 3] ?? 0) | (0x80 >> (minute & 7));
  }
  return bitmap;
}

export function isBitmap(bytes: Uint8Array): bytes is Bitmap {
  return bytes.length === BITMAP_BYTES;
}

function combine(a: Bitmap, b: Bitmap, op: (x: number, y: number) => number): Bitmap {
  const out = new Uint8Array(BITMAP_BYTES);
  for (let i = 0; i < BITMAP_BYTES; i++) {
    out[i] = op(a[i] ?? 0, b[i] ?? 0) & 0xff;
  }
  return out;
}

export function orBits(a: Bitmap, b: Bitmap): Bitmap {
  return combine(a, b, (x, y) => x | y);
}

/** `a & ~b`。read から write と重なる分を除くのに使う。 */
export function andNotBits(a: Bitmap, b: Bitmap): Bitmap {
  return combine(a, b, (x, y) => x & ~y);
}

export function popcount(bitmap: Bitmap): number {
  let count = 0;
  for (const byte of bitmap) {
    let v = byte;
    while (v !== 0) {
      v &= v - 1;
      count++;
    }
  }
  return count;
}

export function bitsEqual(a: Bitmap, b: Bitmap): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
