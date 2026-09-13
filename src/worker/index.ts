import { DEMO_PUBLIC_ID, renderDemoSvg } from "./svg.ts";

/**
 * Worker のエントリ。
 *
 * 経路は今 `/v1/g/{publicId}.svg` だけで、実データが無いので `demo` 以外は 404。
 * 段階 3 で `/v1/p.gif` (記録の受け口) を足す (docs/roadmap.md)。
 */

/** `publicId` は URL で決まる。どのプロジェクトを描くかをクエリで指定しない (design §6)。 */
const GRAPH_PATH = /^\/v1\/g\/([^/]+)\.svg$/;

export default {
  async fetch(request): Promise<Response> {
    // curl -I などの HEAD も受ける。本文はランタイムが落とす
    if (request.method !== "GET" && request.method !== "HEAD") {
      return notFound();
    }

    const match = GRAPH_PATH.exec(new URL(request.url).pathname);
    if (match?.[1] === DEMO_PUBLIC_ID) {
      return svgResponse(renderDemoSvg());
    }

    // **存在しない publicId も 404。** docs に規定が無かったので決めた (ADR-0014)。
    // Cosense では画像が壊れて表示されるので、「無い」ことが見た目で分かる
    return notFound();
  },

  async scheduled(): Promise<void> {
    // 段階 3 で daybits の掃除を入れる (90 日より古い行を消す。ADR-0013 決定 2)。
  },
} satisfies ExportedHandler<Env>;

function svgResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      // **これが無いと Cosense で表示されない。** Cosense は拡張子で <img> にするかを決め、
      // 描画できるかはブラウザが Content-Type で決める (research §3、過去に踏まれた唯一の落とし穴)
      "content-type": "image/svg+xml; charset=utf-8",
      // 送信が 1 日数回なので短くする意味がない (design §6)
      "cache-control": "public, max-age=900",
      // SVG を直接開くとアクティブコンテンツが実行されうるので、何も読ませない (design §6)
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
    },
  });
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
