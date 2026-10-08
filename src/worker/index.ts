import { ACCOUNT_PATH, AUTH_CALLBACK_PATH, AUTH_START_PATH } from "../shared/auth.ts";
import { INGEST_PATH } from "../shared/beacon.ts";
import { ENROLL_PATH } from "../shared/enroll.ts";
import { CARD_FORM, GRAPH_FORM, type GrassForm } from "../shared/grass.ts";
import { sha256Hex } from "../shared/hash.ts";
import { isValidDataKey, isValidPublicId } from "../shared/ids.ts";
import { PRIVACY_JA_PATH, PRIVACY_PATH } from "../shared/links.ts";
import { PROBE_PATH } from "../shared/probe.ts";
import { REVOKE_PATH } from "../shared/revoke.ts";
import { type AccountDeps, handleAccount } from "./account.ts";
import { type AuthDeps, handleAuthCallback, handleAuthStart } from "./auth.ts";
import { cardIcon } from "./card-icon.ts";
import {
  BACKFILL_LIMIT,
  backfillDailySegments,
  deleteExpiredEnrollTokens,
  deleteOldDaybits,
} from "./cron.ts";
import {
  DEMO_CARD_LABEL,
  DEMO_CARD_USER,
  DEMO_ICON,
  DEMO_PUBLIC_ID,
  DEMO_TODAY,
  demoCardDays,
  demoData,
} from "./demo.ts";
import { handleEnroll, handleRevoke } from "./enroll.ts";
import { FAVICON_CACHE_CONTROL, FAVICON_PATH, FAVICON_SVG } from "./favicon.ts";
import { centerOf } from "./graph/balance.ts";
import { slotPopulation } from "./graph/grass.ts";
import { buildScale } from "./graph/scale.ts";
import { renderStoredGrass } from "./graph-data.ts";
import { renderGrass } from "./grass-svg.ts";
import { GUIDE_CACHE_CONTROL, GUIDE_PATH, renderGuide } from "./guide-svg.ts";
import { googleKeys } from "./idtoken.ts";
import { handleIngest } from "./ingest.ts";
import { type GraphData, loadGraphData } from "./json.ts";
import { d1KeyResolver } from "./keys.ts";
import { parseGrassParams, parseIcon, parseLabel, parseUser } from "./params.ts";
import { handleProbe } from "./probe.ts";
import { HOME_JA_PATH, HOME_PATH, handleHome, handlePrivacy } from "./site.ts";

/**
 * Worker のエントリ。
 *
 * 経路は `/v1/p.gif` (記録の受け口)、`/v1/enroll.gif` (デバイスの登録)、`/v1/revoke.gif` (デバイスの失効)、
 * `/account` (端末の一覧と失効・共有 URL・全削除)、`/` と `/privacy` (人が読むページ)、
 * 図 `/v1/g/{publicId}.svg`・`/v1/g/{publicId}/card.svg`・`/v1/g/{publicId}/overview.svg` (同じ描画で既定の形だけが違う。ADR-0026)、
 * `/v1/g/{publicId}/{dataKey}.json` (日ごとの集計値。ADR-0020)、
 * `/v1/probe.gif` (送信の疎通確認)、`/v1/guide/{name}.svg` (草のダイアログの説明の図。Issue #182)、`/auth/start` と `/auth/callback` (Google サインイン)、`/favicon.svg`。
 * グラフは `demo` ならデモを、それ以外は D1 の記録から描く。
 */

/**
 * 図の経路 (ADR-0026 決定 6)。**3 つとも同じ描画で、既定の形だけが違う** (どれも同じクエリを受ける)。
 * `publicId` は URL で決まる。どのプロジェクトを描くかをクエリで指定しない (design §6)
 */
const GRASS_ROUTES = [
  // カード (ADR-0024)。プロフィールページに自動で貼るのもこれ (ADR-0025)
  { path: /^\/v1\/g\/([^/]+)\/card\.svg$/, form: CARD_FORM, event: "card" },
  // 貼ってある草の意味を保つため、既定は 1 年 × 1 日
  { path: /^\/v1\/g\/([^/]+)\.svg$/, form: GRAPH_FORM, event: "graph" },
  // 活動の概観 (ADR-0021) は廃止した。**壊れた画像にしないよう、カードの既定を返す**
  { path: /^\/v1\/g\/([^/]+)\/overview\.svg$/, form: CARD_FORM, event: "overview" },
] as const;

/** 日ごとの集計値。**草の URL からは導けない鍵を並べる** (ADR-0020)。 */
const GRAPH_DATA_PATH = /^\/v1\/g\/([^/]+)\/([^/]+)\.json$/;

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
    if (url.pathname === HOME_PATH || url.pathname === HOME_JA_PATH) {
      return handleHome(url.pathname === HOME_PATH ? "en" : "ja");
    }
    if (url.pathname === PRIVACY_PATH || url.pathname === PRIVACY_JA_PATH) {
      return handlePrivacy(url.pathname === PRIVACY_PATH ? "en" : "ja");
    }
    if (url.pathname === FAVICON_PATH) {
      return svgResponse(request, FAVICON_SVG, FAVICON_CACHE_CONTROL);
    }
    const guideName = GUIDE_PATH.exec(url.pathname)?.[1];
    if (guideName !== undefined) {
      const body = renderGuide(guideName);
      return body === undefined ? notFound() : svgResponse(request, body, GUIDE_CACHE_CONTROL);
    }

    const data = GRAPH_DATA_PATH.exec(url.pathname);
    // 形の違う publicId と dataKey は D1 を引かずに 404
    if (data?.[1] && data[2] && isValidPublicId(data[1]) && isValidDataKey(data[2])) {
      let graphData: GraphData | undefined;
      try {
        graphData = await loadGraphData(env.DB, data[1], data[2]);
      } catch {
        console.log(JSON.stringify({ event: "graph-data", status: 503 }));
        return unavailable();
      }
      if (graphData !== undefined) {
        return cachedResponse(request, JSON.stringify(graphData), JSON_HEADERS);
      }
      return notFound();
    }

    for (const route of GRASS_ROUTES) {
      const id = route.path.exec(url.pathname)?.[1];
      if (id === undefined) {
        continue;
      }
      if (id === DEMO_PUBLIC_ID) {
        return grassResponse(request, renderDemoGrass(url.searchParams, route.form));
      }
      // 形の違う publicId は D1 を引かずに 404
      if (!isValidPublicId(id)) {
        break;
      }
      let body: string | undefined;
      try {
        body = await renderStoredGrass(
          env.DB,
          id,
          {
            ...parseGrassParams(url.searchParams, route.form),
            label: parseLabel(url.searchParams),
            user: parseUser(url.searchParams),
            gyazo: parseIcon(url.searchParams),
          },
          Date.now(),
          (project, user, gyazo) =>
            cardIcon(
              project,
              user,
              {
                fetch: (iconUrl, init) => fetch(iconUrl, init),
                cache: caches.default,
              },
              gyazo,
            ),
        );
      } catch {
        console.log(JSON.stringify({ event: route.event, status: 503 }));
        return unavailable();
      }
      if (body !== undefined) {
        return grassResponse(request, body);
      }
      break;
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
    // 時間帯の区間が無い daily を、残っている daybits から遡って埋める (Issue #208)。
    // **daybits を消した後に呼ぶ。** 消える日の行を読んでも書いても無駄になるため
    const backfilled = await backfillDailySegments(env.DB, BACKFILL_LIMIT);
    console.log(JSON.stringify({ event: "cron", deleted, expiredTokens, backfilled }));
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

/**
 * 図のデモ (ADR-0024・0026)。右端は `DEMO_TODAY` で、`year` が過去ならその年の 12/31 (記録の無い期間として空の図が出る)。
 * 名前は既定でデモの名前を描き、アイコンは固定の画像を埋め込む (外へ取りに行かない)。
 */
function renderDemoGrass(search: URLSearchParams, defaults: GrassForm): string {
  const params = parseGrassParams(search, defaults);
  const days = demoCardDays();
  const slots = slotPopulation(days);
  // 内訳なしの日の色は草のデモと同じ母集団から取る
  const { population } = demoData();
  return renderGrass({
    today: DEMO_TODAY,
    end: params.end !== undefined && params.end < DEMO_TODAY ? params.end : DEMO_TODAY,
    form: params.form,
    mode: params.mode,
    days,
    slotScale: buildScale(slots.map((m) => m.w + m.r)),
    slotCenter: centerOf(slots),
    dayScale: buildScale(population.map((d) => d.w + d.r)),
    dayCenter: centerOf(population),
    theme: params.theme,
    palette: params.palette,
    lang: params.lang,
    label: parseLabel(search) ?? DEMO_CARD_LABEL,
    user: parseUser(search) ?? DEMO_CARD_USER,
    icon: DEMO_ICON,
  });
}

/**
 * SVG の応答ヘッダ (favicon と説明の図)。
 *
 * - **Content-Type が無いと Cosense で表示されない。** Cosense は拡張子で <img> にするかを決め、
 *   描画できるかはブラウザが Content-Type で決める (research §3、過去に踏まれた唯一の落とし穴)
 * - SVG を直接開くとアクティブコンテンツが実行されうるので、何も読ませない (design §6)
 */
const SVG_HEADERS = {
  "content-type": "image/svg+xml; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  "x-content-type-options": "nosniff",
};

/**
 * 図の応答ヘッダ (ADR-0024 決定 5・ADR-0026 決定 6)。**埋め込んだアイコン (`data:`) のために `img-src data:` だけ足す。**
 * 図を返す 3 つの経路すべてに付ける
 */
const GRASS_SVG_HEADERS = {
  ...SVG_HEADERS,
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
};

/**
 * 日ごとの集計値の JSON の応答ヘッダ (ADR-0020)。
 *
 * - **ほかのサイトのスクリプトから読めるようにする。** Cookie を使わない公開の値なので `*` でよい。
 *   Cosense の中からは CSP の `connect-src` で読めないのは変わらない
 * - **検索に載せない。** URL が公開の場に貼られても、内訳を検索で拾わせない
 */
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "content-security-policy": "default-src 'none'",
  "x-content-type-options": "nosniff",
  "access-control-allow-origin": "*",
  "x-robots-tag": "noindex",
};

function svgResponse(
  request: Request,
  body: string,
  cacheControl = CACHE_CONTROL,
): Promise<Response> {
  return cachedResponse(request, body, SVG_HEADERS, cacheControl);
}

function grassResponse(request: Request, body: string): Promise<Response> {
  return cachedResponse(request, body, GRASS_SVG_HEADERS);
}

/**
 * キャッシュさせる応答。**ETag は本文の SHA-256** (ADR-0015 決定 2)。
 *
 * design §6 は「`users.ver` と描画パラメータから作る」としていたが、それだと配色やレイアウトを
 * 直してデプロイしても、キャッシュを持つ側に 304 が返り続けて古い画像が残る。本文から作れば
 * 描画が変わったときだけ変わり、常に正しい。
 */
async function cachedResponse(
  request: Request,
  body: string,
  headers: Readonly<Record<string, string>>,
  cacheControl = CACHE_CONTROL,
): Promise<Response> {
  const etag = `"${await sha256Hex(body, ETAG_LENGTH)}"`;

  if (ifNoneMatch(request.headers.get("if-none-match"), etag)) {
    // 304 にも ETag と Cache-Control を付ける (RFC 9110)
    return new Response(null, { status: 304, headers: { etag, "cache-control": cacheControl } });
  }

  return new Response(body, {
    status: 200,
    // 草は、送信が 1 日数回なので短くする意味がない (design §6)
    headers: { ...headers, "cache-control": cacheControl, etag },
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
