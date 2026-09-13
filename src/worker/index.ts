import { centerOf } from "../shared/balance.ts";
import { sha256Hex } from "../shared/hash.ts";
import { PROBE_PATH } from "../shared/probe.ts";
import { buildScale } from "../shared/scale.ts";
import { DEMO_TODAY, demoData } from "./demo.ts";
import { parseParams } from "./params.ts";
import { handleProbe } from "./probe.ts";
import { DEMO_PUBLIC_ID, renderGraph } from "./svg.ts";

/**
 * Worker のエントリ。
 *
 * 経路は今 `/v1/g/{publicId}.svg` と `/v1/probe.gif` (送信の疎通確認) だけ。
 * 実データが無いので、グラフは `demo` 以外 404。
 * 段階 3 で `/v1/p.gif` (記録の受け口) を足す (docs/roadmap.md)。
 */

/** `publicId` は URL で決まる。どのプロジェクトを描くかをクエリで指定しない (design §6)。 */
const GRAPH_PATH = /^\/v1\/g\/([^/]+)\.svg$/;

const CACHE_CONTROL = "public, max-age=900";

/** ETag は本文の SHA-256 の先頭 32 桁。 */
const ETAG_LENGTH = 32;

export default {
  async fetch(request): Promise<Response> {
    // curl -I などの HEAD も受ける。本文はランタイムが落とす
    if (request.method !== "GET" && request.method !== "HEAD") {
      return notFound();
    }

    const url = new URL(request.url);
    if (url.pathname === PROBE_PATH) {
      return handleProbe(request, url);
    }

    const match = GRAPH_PATH.exec(url.pathname);
    if (match?.[1] === DEMO_PUBLIC_ID) {
      return svgResponse(request, renderDemo(url.searchParams));
    }

    // **存在しない publicId は 404** (design §6)。Cosense では画像が壊れて表示されるので、
    // 「無い」ことが見た目で分かる
    return notFound();
  },

  async scheduled(): Promise<void> {
    // 段階 3 で daybits の掃除を入れる (90 日より古い行を消す。ADR-0013 決定 2)。
  },
} satisfies ExportedHandler<Env>;

function renderDemo(search: URLSearchParams): string {
  const { days, population } = demoData();
  // 四分位と中心は**表示範囲とは別の母集団** (全期間) から取る (design §7)
  const scale = buildScale(population.map((d) => d.w + d.r));
  const center = centerOf(population);
  return renderGraph({ today: DEMO_TODAY, days, scale, center, params: parseParams(search) });
}

/**
 * SVG を返す。**ETag は本文の SHA-256** (ADR-0015 決定 2)。
 *
 * design §6 は「`users.ver` と描画パラメータから作る」としていたが、それだと配色やレイアウトを
 * 直してデプロイしても、キャッシュを持つ側に 304 が返り続けて古い画像が残る。本文から作れば
 * 描画が変わったときだけ変わり、常に正しい。
 */
async function svgResponse(request: Request, body: string): Promise<Response> {
  const etag = `"${await sha256Hex(body, ETAG_LENGTH)}"`;

  if (ifNoneMatch(request.headers.get("if-none-match"), etag)) {
    // 304 にも ETag と Cache-Control を付ける (RFC 9110)
    return new Response(null, { status: 304, headers: { etag, "cache-control": CACHE_CONTROL } });
  }

  return new Response(body, {
    status: 200,
    headers: {
      // **これが無いと Cosense で表示されない。** Cosense は拡張子で <img> にするかを決め、
      // 描画できるかはブラウザが Content-Type で決める (research §3、過去に踏まれた唯一の落とし穴)
      "content-type": "image/svg+xml; charset=utf-8",
      // 送信が 1 日数回なので短くする意味がない (design §6)
      "cache-control": CACHE_CONTROL,
      // SVG を直接開くとアクティブコンテンツが実行されうるので、何も読ませない (design §6)
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
      etag,
    },
  });
}

/**
 * `If-None-Match` が ETag に一致するか。RFC 9110 どおり**弱い比較**にする (`W/` を剥がして比べる)。
 * Cloudflare は圧縮するときに強い ETag を弱い ETag に変えることがある。
 */
function ifNoneMatch(header: string | null, etag: string): boolean {
  if (header === null) {
    return false;
  }
  if (header.trim() === "*") {
    return true;
  }
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => opaque(tag) === opaque(etag));
}

function notFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
