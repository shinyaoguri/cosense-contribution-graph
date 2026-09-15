import { ACCOUNT_PATH, AUTH_CALLBACK_PATH, AUTH_START_PATH } from "../shared/auth.ts";
import { INGEST_PATH } from "../shared/beacon.ts";
import { ENROLL_PATH } from "../shared/enroll.ts";
import { sha256Hex } from "../shared/hash.ts";
import { isValidPublicId } from "../shared/ids.ts";
import { PROBE_PATH } from "../shared/probe.ts";
import { REVOKE_PATH } from "../shared/revoke.ts";
import { type AccountDeps, handleAccount } from "./account.ts";
import { type AuthDeps, handleAuthCallback, handleAuthStart } from "./auth.ts";
import { deleteExpiredEnrollTokens, deleteOldDaybits } from "./cron.ts";
import { DEMO_TODAY, demoData } from "./demo.ts";
import { handleEnroll, handleRevoke } from "./enroll.ts";
import { centerOf } from "./graph/balance.ts";
import { buildScale } from "./graph/scale.ts";
import { renderStoredGraph } from "./graph-data.ts";
import { googleKeys } from "./idtoken.ts";
import { handleIngest } from "./ingest.ts";
import { d1KeyResolver } from "./keys.ts";
import { parseParams } from "./params.ts";
import { handleProbe } from "./probe.ts";
import { HOME_PATH, handleHome, handlePrivacy, PRIVACY_PATH } from "./site.ts";
import { DEMO_PUBLIC_ID, renderGraph } from "./svg.ts";

/**
 * Worker のエントリ。
 *
 * 経路は `/v1/p.gif` (記録の受け口)、`/v1/enroll.gif` (デバイスの登録)、`/v1/revoke.gif` (デバイスの失効)、
 * `/account` (端末の一覧と失効・共有 URL・全削除)、`/` と `/privacy` (人が読むページ)、`/v1/g/{publicId}.svg`、
 * `/v1/probe.gif` (送信の疎通確認)、`/auth/start` と `/auth/callback` (Google サインイン)。
 * グラフは `demo` ならデモを、それ以外は D1 の記録から描く。
 */

/** `publicId` は URL で決まる。どのプロジェクトを描くかをクエリで指定しない (design §6)。 */
const GRAPH_PATH = /^\/v1\/g\/([^/]+)\.svg$/;

const CACHE_CONTROL = "public, max-age=900";

/** ETag は本文の SHA-256 の先頭 32 桁。 */
const ETAG_LENGTH = 32;

/**
 * Google の JWKS。**モジュールの最上位で 1 つ作り、isolate の中で使い回す** (idtoken.ts)。
 * 作るだけでは取りに行かない (最初の callback で取る) ので、グローバルスコープで I/O を禁じる workerd の制約に触れない。
 */
const GOOGLE_KEYS = googleKeys({ fetch: (url) => fetch(url), now: () => Date.now() });

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // **POST を受けるのは管理のページだけ** (失効と全削除のフォーム。ADR-0017・0018)
    if (url.pathname === ACCOUNT_PATH && request.method === "POST") {
      return handleAccount(request, accountDeps(env));
    }
    // curl -I などの HEAD も受ける。本文はランタイムが落とす
    if (request.method !== "GET" && request.method !== "HEAD") {
      return notFound();
    }
    if (url.pathname === INGEST_PATH) {
      // **記録は GET だけ。** HEAD で書き込ませない
      if (request.method !== "GET") {
        return notFound();
      }
      return handleIngest(url, {
        db: env.DB,
        resolveKey: d1KeyResolver(env.DB),
        now: () => Date.now(),
      });
    }
    if (url.pathname === ENROLL_PATH) {
      // **登録も GET だけ。** HEAD でトークンを消費させない
      if (request.method !== "GET") {
        return notFound();
      }
      return handleEnroll(url, { db: env.DB, now: () => Date.now() });
    }
    if (url.pathname === REVOKE_PATH) {
      // **失効も GET だけ。** HEAD で鍵を消させない
      if (request.method !== "GET") {
        return notFound();
      }
      return handleRevoke(url, {
        db: env.DB,
        resolveKey: d1KeyResolver(env.DB),
        now: () => Date.now(),
      });
    }
    if (url.pathname === ACCOUNT_PATH) {
      return handleAccount(request, accountDeps(env));
    }
    if (url.pathname === AUTH_START_PATH || url.pathname === AUTH_CALLBACK_PATH) {
      // **GET だけ。** HEAD で code を交換させない・登録トークンを発行させない
      if (request.method !== "GET") {
        return notFound();
      }
      return url.pathname === AUTH_START_PATH
        ? handleAuthStart(url, authDeps(env))
        : handleAuthCallback(url, request.headers.get("cookie"), authDeps(env));
    }
    if (url.pathname === PROBE_PATH) {
      return handleProbe(request, url);
    }
    if (url.pathname === HOME_PATH) {
      return handleHome();
    }
    if (url.pathname === PRIVACY_PATH) {
      return handlePrivacy();
    }

    const publicId = GRAPH_PATH.exec(url.pathname)?.[1];
    if (publicId === DEMO_PUBLIC_ID) {
      return svgResponse(request, renderDemo(url.searchParams));
    }
    // 形の違う publicId は D1 を引かずに 404
    if (publicId !== undefined && isValidPublicId(publicId)) {
      let body: string | undefined;
      try {
        body = await renderStoredGraph(env.DB, publicId, parseParams(url.searchParams), Date.now());
      } catch {
        console.log(JSON.stringify({ event: "graph", status: 503 }));
        return unavailable();
      }
      if (body !== undefined) {
        return svgResponse(request, body);
      }
    }

    // **存在しない publicId は 404** (design §6)。Cosense では画像が壊れて表示されるので、
    // 「無い」ことが見た目で分かる
    return notFound();
  },

  async scheduled(controller, env): Promise<void> {
    // 90 日より古い daybits を消す (ADR-0013 決定 2)。時刻は Cron が起動した予定時刻で決める
    const deleted = await deleteOldDaybits(env.DB, controller.scheduledTime);
    // 使われずに期限が切れた登録トークンを消す
    const expiredTokens = await deleteExpiredEnrollTokens(env.DB, controller.scheduledTime);
    console.log(JSON.stringify({ event: "cron", deleted, expiredTokens }));
  },
} satisfies ExportedHandler<Env>;

function authDeps(env: Env): AuthDeps {
  return {
    db: env.DB,
    secret: env.WORKER_SECRET,
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    publicOrigin: env.PUBLIC_ORIGIN,
    keys: GOOGLE_KEYS,
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
  };
}

function accountDeps(env: Env): AccountDeps {
  return {
    db: env.DB,
    secret: env.WORKER_SECRET,
    publicOrigin: env.PUBLIC_ORIGIN,
    now: () => Date.now(),
  };
}

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

/** D1 が読めないとき。**キャッシュさせない** (壊れた画像が 15 分残らないように)。 */
function unavailable(): Response {
  return new Response("Service Unavailable", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
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
