/**
 * 送信の疎通確認 `GET /v1/probe.gif` の取り決め (design §6)。Worker と UserScript の両方が使う。
 *
 * **記録しない。** 乱数の中身とそのハッシュを送り、Worker が観測した結果を GIF の幅で返す。
 * 画像の本文は JS から読めないが、`naturalWidth` は読める (ADR-0001)。
 */
import { sha256Hex } from "./hash.ts";

export const PROBE_PATH = "/v1/probe.gif";

export const PROBE_VERSION = "1";

/** クエリの名前。 */
export const PROBE_PARAM = {
  version: "v",
  /** 中身 (base64url の文字だけ)。乱数なので URL も毎回変わる */
  payload: "d",
  /** 中身の SHA-256 の先頭 `PROBE_DIGEST_LENGTH` 桁 */
  digest: "h",
} as const;

export const PROBE_DIGEST_LENGTH = 32;

/**
 * 中身の上限。Cloudflare の URL の上限 16KB に合わせる (research §1)。
 * これを超える URL はそもそも Worker に届かない。
 */
export const PROBE_PAYLOAD_MAX = 16_384;

/**
 * 応答の GIF の幅 = これ + ビットの和 (16〜23)。
 * 16 から始めるのは、途中の何かが返した 1×1 の画像を「届いた」と取り違えないため。
 */
export const PROBE_WIDTH_BASE = 16;

/** Worker が観測した結果。 */
export type ProbeFlags = {
  /** `h` が `d` の SHA-256 と一致した (中身が壊れずに届いた) */
  readonly intact: boolean;
  /** `Referer` ヘッダが届いた */
  readonly referer: boolean;
  /** `Sec-Fetch-Dest` が `image` でない (Service Worker が作り直した、または画像以外から送った) */
  readonly notImageDest: boolean;
};

const BIT = { intact: 1, referer: 2, notImageDest: 4 } as const;
const BIT_MASK = BIT.intact | BIT.referer | BIT.notImageDest;

export function probeDigest(payload: string): Promise<string> {
  return sha256Hex(payload, PROBE_DIGEST_LENGTH);
}

export function probeWidth(flags: ProbeFlags): number {
  return (
    PROBE_WIDTH_BASE +
    (flags.intact ? BIT.intact : 0) +
    (flags.referer ? BIT.referer : 0) +
    (flags.notImageDest ? BIT.notImageDest : 0)
  );
}

/** 幅からビットを読む。取り決めの範囲 (16〜23) の外なら `undefined`。 */
export function readProbeWidth(width: number): ProbeFlags | undefined {
  const bits = width - PROBE_WIDTH_BASE;
  if (!Number.isInteger(bits) || bits < 0 || bits > BIT_MASK) {
    return undefined;
  }
  return {
    intact: (bits & BIT.intact) !== 0,
    referer: (bits & BIT.referer) !== 0,
    notImageDest: (bits & BIT.notImageDest) !== 0,
  };
}
