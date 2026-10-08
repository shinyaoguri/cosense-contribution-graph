/**
 * カードの図に埋め込む Cosense のアイコンを取る (design §6、ADR-0024 決定 5)。
 *
 * **`<img>` で読まれた SVG は外部の画像を読まない**ので、URL ではなく中身を `data:` の URI にして埋め込む。
 *
 * - 取り先は `https://scrapbox.io/api/pages/<l>/<u>/icon` (`[user.icon]` と同じもの。research §4)。
 *   302 でそのページの画像へ転送されるので、**転送は自分で辿り** (`redirect: "manual"`)、行き先のホストを許可リストで確かめる。
 *   Google のアイコン (`lh3.googleusercontent.com`) など、許可リストの外へ転送されたら諦める
 * - **非公開プロジェクトは未認証では引けない** (401。research §4) ので、UserScript が図の URL の `?i=` で Gyazo の画像 ID を渡す (ADR-0028)。
 *   **渡された URL は取らず、ID から `https://gyazo.com/<id>/max_size/64` を自分で組み立てる。** 取れなければ上の `/icon` に落ちる
 * - Gyazo は `/max_size/400` で返るので `/max_size/64` に替えて小さく取る
 * - 種類は png / jpeg / gif / webp だけ。**SVG は入れない** (スクリプトや外部参照を持ちうる)。大きすぎるものも捨てる
 * - 結果は**失敗も含めて** Cache API に置く (成功 1 日、失敗 1 時間)。D1 には保存しない。
 *   **鍵は (project, user) と Gyazo の ID で別々にする** — 先に ID 無しで失敗を記憶しても、ID 付きの要求が引きずられない
 * - **取れないときは undefined** (名前だけにする)。例外は外へ出さない
 *
 * `fetch` と `cache` は注入する (テストでは偽物にし、外へ取りに行かない)。
 */
import { isValidGyazoId } from "../shared/gyazo-id.ts";

/** 転送を辿ってよいホスト */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "scrapbox.io",
  "gyazo.com",
  "i.gyazo.com",
  "storage.googleapis.com",
]);

const GYAZO_HOSTS: ReadonlySet<string> = new Set(["gyazo.com", "i.gyazo.com"]);

/** 埋め込んでよい種類。**SVG は入れない** */
const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** 本体の上限。アイコンは 16px で描くので、小さいサイズで取れば十分に収まる */
export const MAX_ICON_BYTES = 64 * 1024;

/** 辿る転送の段数。scrapbox.io → gyazo.com → i.gyazo.com、scrapbox.io → scrapbox.io/files → storage.googleapis.com の 2 段 */
const MAX_REDIRECTS = 2;

/** Gyazo から取るときの大きさ */
const GYAZO_MAX_SIZE = 64;

const HIT_TTL_SECONDS = 86_400;
const MISS_TTL_SECONDS = 3_600;

/** キャッシュの鍵の置き場。**外から引ける URL にはしない** (`.invalid` は名前解決されない) */
const CACHE_ORIGIN = "https://card-icon.invalid";

export type IconCache = {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
};

export type IconDeps = {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly cache: IconCache;
};

/** Gyazo の ID の鍵の置き場。**`CACHE_ORIGIN` と別のホストにする** — project 名が `gyazo` で user 名が ID の形のときに (project, user) の鍵とぶつからない */
const GYAZO_CACHE_ORIGIN = "https://card-icon-gyazo.invalid";

/** キャッシュの鍵 */
export function iconCacheKey(project: string, user: string): string {
  return `${CACHE_ORIGIN}/${encodeURIComponent(project)}/${encodeURIComponent(user)}`;
}

/** Gyazo の ID のキャッシュの鍵 (ADR-0028)。**呼ぶ側が `isValidGyazoId` を通したものだけを渡す** */
export function gyazoCacheKey(id: string): string {
  return `${GYAZO_CACHE_ORIGIN}/${id}`;
}

/**
 * アイコンの `data:` URI。取れなければ undefined。**キャッシュにあれば外へ取りに行かない。**
 * 失敗もキャッシュする (非公開プロジェクトや画像の無いページを毎回引かない)。
 *
 * `gyazoId` (UserScript が渡した画像 ID。ADR-0028) が**形を通れば先に**そこから取り、取れなければ `/icon` に落ちる。
 * 形が外れていれば無かったものとして扱う (URL の部品にしない)
 */
export async function cardIcon(
  project: string,
  user: string,
  deps: IconDeps,
  gyazoId?: string,
): Promise<string | undefined> {
  if (gyazoId !== undefined && isValidGyazoId(gyazoId)) {
    const icon = await cached(gyazoCacheKey(gyazoId), deps, () =>
      fetchImage(new URL(`https://gyazo.com/${gyazoId}/max_size/${GYAZO_MAX_SIZE}`), deps.fetch),
    );
    if (icon !== undefined) {
      return icon;
    }
  }
  return cached(iconCacheKey(project, user), deps, () =>
    fetchImage(
      new URL(
        `https://scrapbox.io/api/pages/${encodeURIComponent(project)}/${encodeURIComponent(user)}/icon`,
      ),
      deps.fetch,
    ),
  );
}

/** キャッシュを引き、無ければ取って置く。**失敗 (例外も含む) は空文字で記憶し、例外は外へ出さない** */
async function cached(
  key: string,
  deps: IconDeps,
  produce: () => Promise<string | undefined>,
): Promise<string | undefined> {
  try {
    const cached = await deps.cache.match(key);
    if (cached !== undefined) {
      const text = await cached.text();
      return text === "" ? undefined : text;
    }
  } catch {
    // キャッシュが読めなくても取りに行く
  }

  let icon: string | undefined;
  try {
    icon = await produce();
  } catch {
    icon = undefined;
  }

  try {
    await deps.cache.put(
      key,
      new Response(icon ?? "", {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": `max-age=${icon === undefined ? MISS_TTL_SECONDS : HIT_TTL_SECONDS}`,
        },
      }),
    );
  } catch {
    // キャッシュに置けなくても描く
  }
  return icon;
}

/** 転送先を確かめる。許可リストの外・https でない・資格情報付きなら undefined。Gyazo は大きさを替える */
function allowedIconUrl(location: string, base: URL): URL | undefined {
  let url: URL;
  try {
    url = new URL(location, base);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !ALLOWED_HOSTS.has(url.hostname)
  ) {
    return undefined;
  }
  if (GYAZO_HOSTS.has(url.hostname)) {
    url.pathname = url.pathname.replace(/\/max_size\/\d+/, `/max_size/${GYAZO_MAX_SIZE}`);
  }
  return url;
}

/** `start` から転送を辿って画像を取り、`data:` の URI にする。**許可リスト・種類・大きさの検査はどこから始めても同じ** */
async function fetchImage(start: URL, fetchFn: IconDeps["fetch"]): Promise<string | undefined> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchFn(url.href, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      const next = location === null ? undefined : allowedIconUrl(location, url);
      if (next === undefined) {
        return undefined;
      }
      url = next;
      continue;
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      return undefined;
    }
    const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const length = Number(res.headers.get("content-length") ?? "0");
    if (!ALLOWED_TYPES.has(type) || length > MAX_ICON_BYTES) {
      await res.body?.cancel();
      return undefined;
    }
    const bytes = await readLimited(res, MAX_ICON_BYTES);
    return bytes === undefined || bytes.length === 0
      ? undefined
      : `data:${type};base64,${toBase64(bytes)}`;
  }
  // 転送が多すぎる
  return undefined;
}

/** 本体を `max` バイトまで読む。超えたら読むのをやめて undefined */
async function readLimited(res: Response, max: number): Promise<Uint8Array | undefined> {
  if (res.body === null) {
    return undefined;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
