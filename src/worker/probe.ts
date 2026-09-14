/**
 * `GET /v1/probe.gif` — 送信の疎通確認 (design §6)。
 *
 * **記録しない。** D1 も認証も使わず、届いたリクエストを観測して GIF の幅で返すだけ。
 * 段階 8 の設定画面の「接続テスト」にも使う。Bot Fight Mode のように画像ビーコンを静かに壊す要因を、
 * 利用者が切り分けられる。
 */
import {
  PROBE_DIGEST_LENGTH,
  PROBE_PARAM,
  PROBE_PAYLOAD_MAX,
  PROBE_VERSION,
  type ProbeFlags,
  probeDigest,
  probeWidth,
} from "../shared/probe.ts";
import { gifResponse, plainResponse } from "./responses.ts";

const PAYLOAD_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${PROBE_PAYLOAD_MAX}}$`);
const DIGEST_PATTERN = new RegExp(`^[0-9a-f]{${PROBE_DIGEST_LENGTH}}$`);

export async function handleProbe(request: Request, url: URL): Promise<Response> {
  const search = url.searchParams;
  const payload = search.get(PROBE_PARAM.payload);
  const digest = search.get(PROBE_PARAM.digest);

  // 形が不正なら画像を返さない。クライアントは onerror で「届かなかった」と区別できない代わりに、
  // 取り決めの違うクライアントを「届いた」と誤判定しない
  if (
    search.get(PROBE_PARAM.version) !== PROBE_VERSION ||
    payload === null ||
    !PAYLOAD_PATTERN.test(payload) ||
    digest === null ||
    !DIGEST_PATTERN.test(digest)
  ) {
    return plainResponse(400);
  }

  const referer = request.headers.get("referer");
  const flags: ProbeFlags = {
    intact: (await probeDigest(payload)) === digest,
    referer: referer !== null,
    notImageDest: request.headers.get("sec-fetch-dest") !== "image",
    refererPath: referer !== null && !isOriginOnly(referer),
  };
  const width = probeWidth(flags);

  // Workers Logs に 1 行。**IP・UA・中身・Referer の値は出さない**
  console.log(JSON.stringify({ event: "probe", bytes: payload.length, flags: width }));

  return gifResponse(width);
}

/**
 * `https://scrapbox.io/` のようにオリジンだけか。
 *
 * Cosense の Service Worker が画像を作り直すと、Referer は Service Worker のオリジンだけになるはず (Issue #31)。
 * パスが載っていればプロジェクト名とページ名が運営者に流れるので、そこを区別する。
 */
function isOriginOnly(referer: string): boolean {
  if (!URL.canParse(referer)) {
    return false;
  }
  const url = new URL(referer);
  return url.pathname === "/" && url.search === "" && url.hash === "";
}
