/**
 * 送信の疎通確認 (Issue #31)。Worker の `GET /v1/probe.gif` へ画像 GET を送り、結果を読む。
 *
 * **送るのは乱数だけ。** プロジェクト名もページ名も送らない。
 */
import {
  PROBE_PARAM,
  PROBE_PATH,
  PROBE_VERSION,
  type ProbeFlags,
  probeDigest,
  readProbeWidth,
} from "../shared/probe.ts";

/** 本番の Worker。独自ドメインに載せたら差し替える (design §11)。 */
export const WORKER_ORIGIN = "https://cosense-grass.soui.workers.dev";

const TIMEOUT_MS = 15_000;

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export type ProbeResult =
  | { readonly kind: "loaded"; readonly flags: ProbeFlags }
  /** 画像は読めたが、幅が取り決めの外。途中の何かが別の画像を返している */
  | { readonly kind: "unexpected"; readonly width: number }
  /** 画像として読めなかった (届かなかった、または 400) */
  | { readonly kind: "error" }
  | { readonly kind: "timeout" };

/** base64url の文字だけでできた、長さ `length` の乱数。 */
export function randomPayload(length: number): string {
  // 256 は 64 で割り切れるので、下位 6 bit を取っても偏らない
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => BASE64URL[b & 63]).join("");
}

export async function probeUrl(payload: string, origin: string = WORKER_ORIGIN): Promise<string> {
  const url = new URL(PROBE_PATH, origin);
  url.searchParams.set(PROBE_PARAM.version, PROBE_VERSION);
  url.searchParams.set(PROBE_PARAM.payload, payload);
  url.searchParams.set(PROBE_PARAM.digest, await probeDigest(payload));
  return url.href;
}

type ImageLike = Pick<HTMLImageElement, "referrerPolicy" | "src" | "naturalWidth"> & {
  onload: (() => void) | null;
  onerror: (() => void) | null;
};

export type SendOptions = {
  readonly timeoutMs?: number;
  /** テストで偽の画像に差し替える */
  readonly createImage?: () => ImageLike;
};

export function sendProbe(url: string, options: SendOptions = {}): Promise<ProbeResult> {
  const image = options.createImage?.() ?? new Image();
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ kind: "timeout" }), options.timeoutMs ?? TIMEOUT_MS);
    function finish(result: ProbeResult) {
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(result);
    }

    image.onload = () => {
      const flags = readProbeWidth(image.naturalWidth);
      finish(flags ? { kind: "loaded", flags } : { kind: "unexpected", width: image.naturalWidth });
    };
    image.onerror = () => finish({ kind: "error" });
    // **`src` より前に設定する。** 後から設定しても、始まったリクエストには効かない (ADR-0001)
    image.referrerPolicy = "no-referrer";
    image.src = url;
  });
}

export async function runProbe(length: number, options: SendOptions = {}): Promise<ProbeResult> {
  return sendProbe(await probeUrl(randomPayload(length)), options);
}

/** 結果を 1 行の日本語にする。 */
export function describeResult(result: ProbeResult): string {
  switch (result.kind) {
    case "loaded": {
      const { intact, referer, notImageDest, refererPath } = result.flags;
      return [
        "届いた",
        intact ? "中身一致" : "★中身が違う",
        referer
          ? `★Referer あり (${refererPath ? "パスまで含む" : "オリジンだけ"})`
          : "Referer なし",
        notImageDest ? "★Sec-Fetch-Dest が image 以外" : "Sec-Fetch-Dest: image",
      ].join(" / ");
    }
    case "unexpected":
      return `★画像は読めたが幅が想定外 (${result.width})`;
    case "error":
      return "★届かなかった (画像として読めない)";
    case "timeout":
      return "★15 秒で応答が無い";
  }
}
