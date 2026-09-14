/**
 * 画像 GET で Worker に送る (ADR-0001)。Cosense の CSP で `fetch` も `sendBeacon` も使えないので、
 * `img-src *` を通る画像リクエストだけが外へ出られる。
 *
 * 画像の本文は JS から読めないが、`naturalWidth` は読める。Worker は結果を GIF の幅で返す。
 */

const TIMEOUT_MS = 15_000;

export type ImageLike = Pick<HTMLImageElement, "referrerPolicy" | "src" | "naturalWidth"> & {
  onload: (() => void) | null;
  onerror: (() => void) | null;
};

export type ImageOptions = {
  readonly timeoutMs?: number;
  /** テストで偽の画像に差し替える */
  readonly createImage?: () => ImageLike;
};

export type ImageResult =
  | { readonly kind: "loaded"; readonly width: number }
  /** 画像として読めなかった (届かなかった、または 4xx / 5xx) */
  | { readonly kind: "error" }
  | { readonly kind: "timeout" };

export function requestImage(url: string, options: ImageOptions = {}): Promise<ImageResult> {
  const image = options.createImage?.() ?? new Image();
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ kind: "timeout" }), options.timeoutMs ?? TIMEOUT_MS);
    function finish(result: ImageResult) {
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(result);
    }

    image.onload = () => finish({ kind: "loaded", width: image.naturalWidth });
    image.onerror = () => finish({ kind: "error" });
    // **`src` より前に設定する。** 後から設定しても、始まったリクエストには効かない (ADR-0001)
    image.referrerPolicy = "no-referrer";
    image.src = url;
  });
}
