/**
 * UserScript が話しかける本番の Worker。
 *
 * **独自ドメイン** (ADR-0014 決定 10)。`cosense-grass.soui.workers.dev` も有効のまま残しているが、UserScript からは使わない。
 * サインインのポップアップの postMessage も、このオリジンから来たものだけを受け取る。
 */
export const WORKER_ORIGIN = "https://grass.soui.dev";

/** 共有 SVG の URL (design §6)。 */
export function graphUrl(publicId: string): string {
  return `${WORKER_ORIGIN}/v1/g/${publicId}.svg`;
}
