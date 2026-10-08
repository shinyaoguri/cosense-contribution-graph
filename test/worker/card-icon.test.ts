import { describe, expect, it } from "vitest";
import {
  cardIcon,
  gyazoCacheKey,
  type IconCache,
  type IconDeps,
  iconCacheKey,
  MAX_ICON_BYTES,
} from "../../src/worker/card-icon.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PNG_URI = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`;
const ICON_API = "https://scrapbox.io/api/pages/proj/taro/icon";

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
const image = (type: string, body: BodyInit = PNG, headers: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": type, ...headers } });

/** URL ごとの応答を返す偽の fetch。呼ばれた URL と init を記録する */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined) {
      throw new Error(`想定しない取得: ${url}`);
    }
    return route();
  };
  return { fetch, calls };
}

function fakeCache() {
  const store = new Map<string, { body: string; cacheControl: string | null }>();
  const cache: IconCache = {
    async match(key) {
      const hit = store.get(key);
      return hit === undefined ? undefined : new Response(hit.body);
    },
    async put(key, response) {
      store.set(key, {
        body: await response.text(),
        cacheControl: response.headers.get("cache-control"),
      });
    },
  };
  return { cache, store };
}

function deps(routes: Record<string, () => Response>) {
  const f = fakeFetch(routes);
  const c = fakeCache();
  const value: IconDeps = { fetch: f.fetch, cache: c.cache };
  return { deps: value, calls: f.calls, store: c.store };
}

describe("cardIcon", () => {
  it("**Gyazo へ転送されたら max_size を 64 に替えて辿り**、data: の URI を返す", async () => {
    const { deps: d, calls } = deps({
      [ICON_API]: () => redirect("https://gyazo.com/abc/max_size/400"),
      "https://gyazo.com/abc/max_size/64": () =>
        redirect("https://i.gyazo.com/thumb_dpr/64/abc-png.png"),
      "https://i.gyazo.com/thumb_dpr/64/abc-png.png": () => image("image/png"),
    });

    expect(await cardIcon("proj", "taro", d)).toBe(PNG_URI);
    expect(calls.map((c) => c.url)).toEqual([
      ICON_API,
      "https://gyazo.com/abc/max_size/64",
      "https://i.gyazo.com/thumb_dpr/64/abc-png.png",
    ]);
    // 転送は自分で辿る
    expect(calls.every((c) => c.init.redirect === "manual")).toBe(true);
  });

  it("scrapbox.io/files から storage.googleapis.com への転送も辿る (相対の Location も解決する)", async () => {
    const { deps: d } = deps({
      [ICON_API]: () => redirect("/files/x.jpg?type=thumbnail&size=small"),
      "https://scrapbox.io/files/x.jpg?type=thumbnail&size=small": () =>
        redirect("https://storage.googleapis.com/bucket/x-small?sig=1"),
      "https://storage.googleapis.com/bucket/x-small?sig=1": () =>
        image("image/jpeg; charset=binary"),
    });

    expect(await cardIcon("proj", "taro", d)).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("**許可しないホスト・https でない URL への転送では諦め、そこへは取りに行かない**", async () => {
    for (const location of [
      "https://lh3.googleusercontent.com/a-/xyz=s96-c#.png",
      "http://i.gyazo.com/abc.png",
      "https://gyazo.com.example.com/abc.png",
      "https://user:pass@gyazo.com/abc.png",
    ]) {
      const { deps: d, calls } = deps({ [ICON_API]: () => redirect(location) });
      expect(await cardIcon("proj", "taro", d), location).toBeUndefined();
      expect(calls, location).toHaveLength(1);
    }
  });

  it("**SVG と、許可しない種類は埋め込まない**", async () => {
    for (const type of ["image/svg+xml", "text/html", ""]) {
      const { deps: d } = deps({ [ICON_API]: () => image(type) });
      expect(await cardIcon("proj", "taro", d), type).toBeUndefined();
    }
  });

  it("**大きすぎるものは捨てる** (Content-Length でも、実際に読んだ量でも)", async () => {
    const big = new Uint8Array(MAX_ICON_BYTES + 1);
    const declared = deps({
      [ICON_API]: () => image("image/png", PNG, { "content-length": String(MAX_ICON_BYTES + 1) }),
    });
    expect(await cardIcon("proj", "taro", declared.deps)).toBeUndefined();

    // Content-Length の無いストリーム
    const streamed = deps({
      [ICON_API]: () =>
        image(
          "image/png",
          new ReadableStream({
            start(controller) {
              controller.enqueue(big.subarray(0, 40_000));
              controller.enqueue(big.subarray(40_000));
              controller.close();
            },
          }),
        ),
    });
    expect(await cardIcon("proj", "taro", streamed.deps)).toBeUndefined();

    const exact = deps({ [ICON_API]: () => image("image/png", new Uint8Array(MAX_ICON_BYTES)) });
    expect(await cardIcon("proj", "taro", exact.deps)).toMatch(/^data:image\/png;base64,/);
  });

  it("404・転送が多すぎる・取得の失敗は undefined", async () => {
    const notFound = deps({ [ICON_API]: () => new Response("{}", { status: 404 }) });
    expect(await cardIcon("proj", "taro", notFound.deps)).toBeUndefined();

    const loop = deps({
      [ICON_API]: () => redirect("https://scrapbox.io/a"),
      "https://scrapbox.io/a": () => redirect("https://scrapbox.io/b"),
      "https://scrapbox.io/b": () => redirect("https://scrapbox.io/c"),
      "https://scrapbox.io/c": () => image("image/png"),
    });
    expect(await cardIcon("proj", "taro", loop.deps)).toBeUndefined();
    expect(loop.calls).toHaveLength(3);

    const thrown = deps({});
    expect(await cardIcon("proj", "taro", thrown.deps)).toBeUndefined();
  });

  it("**成功は 1 日、失敗は 1 時間キャッシュし、キャッシュにあれば取りに行かない**", async () => {
    const ok = deps({ [ICON_API]: () => image("image/png") });
    expect(await cardIcon("proj", "taro", ok.deps)).toBe(PNG_URI);
    expect(ok.store.get(iconCacheKey("proj", "taro"))).toEqual({
      body: PNG_URI,
      cacheControl: "max-age=86400",
    });
    expect(await cardIcon("proj", "taro", ok.deps)).toBe(PNG_URI);
    expect(ok.calls).toHaveLength(1);

    const ng = deps({ [ICON_API]: () => new Response(null, { status: 404 }) });
    expect(await cardIcon("proj", "taro", ng.deps)).toBeUndefined();
    expect(ng.store.get(iconCacheKey("proj", "taro"))).toEqual({
      body: "",
      cacheControl: "max-age=3600",
    });
    expect(await cardIcon("proj", "taro", ng.deps)).toBeUndefined();
    expect(ng.calls).toHaveLength(1);
  });

  it("プロジェクト名とユーザー名は URL エンコードして組み立てる。鍵は外から引けない名前", async () => {
    const user = "太郎 & <x>";
    const encoded = `https://scrapbox.io/api/pages/proj/${encodeURIComponent(user)}/icon`;
    const { deps: d, calls } = deps({ [encoded]: () => image("image/webp") });

    expect(await cardIcon("proj", user, d)).toMatch(/^data:image\/webp;base64,/);
    expect(calls[0]?.url).toBe(encoded);
    expect(iconCacheKey("proj", user)).toBe(
      `https://card-icon.invalid/proj/${encodeURIComponent(user)}`,
    );
  });
});

describe("cardIcon: UserScript が渡す Gyazo の ID (ADR-0028)", () => {
  const ID = "0123456789abcdef0123456789abcdef";
  const THUMB = `https://gyazo.com/${ID}/max_size/64`;
  const FILE = `https://i.gyazo.com/thumb_dpr/64/${ID}-png.png`;

  it("**ID があれば `/icon` を引かず、Gyazo の max_size/64 だけを辿る** (非公開プロジェクトでも取れる)", async () => {
    const { deps: d, calls } = deps({
      [THUMB]: () => redirect(FILE),
      [FILE]: () => image("image/png"),
    });

    expect(await cardIcon("proj", "taro", d, ID)).toBe(PNG_URI);
    expect(calls.map((c) => c.url)).toEqual([THUMB, FILE]);
    expect(calls.every((c) => c.init.redirect === "manual")).toBe(true);
  });

  it("**鍵は Gyazo の ID 単位で、(project, user) の失敗の記憶に引きずられない**", async () => {
    const {
      deps: d,
      calls,
      store,
    } = deps({
      [ICON_API]: () => new Response(null, { status: 401 }),
      [THUMB]: () => redirect(FILE),
      [FILE]: () => image("image/png"),
    });

    // 先に ID 無しで引いて失敗を 1 時間記憶させる (UserScript が古く `i=` を付けない端末から先に読まれた場合)
    expect(await cardIcon("proj", "taro", d)).toBeUndefined();
    expect(store.get(iconCacheKey("proj", "taro"))?.body).toBe("");

    // その後で `i=` 付きで読まれたら、Gyazo から取れる
    expect(await cardIcon("proj", "taro", d, ID)).toBe(PNG_URI);
    expect(store.get(gyazoCacheKey(ID))).toEqual({ body: PNG_URI, cacheControl: "max-age=86400" });
    expect(calls.map((c) => c.url)).toEqual([ICON_API, THUMB, FILE]);

    // 2 回目はキャッシュから。外へ取りに行かない
    expect(await cardIcon("proj", "taro", d, ID)).toBe(PNG_URI);
    expect(calls).toHaveLength(3);
  });

  it("**Gyazo から取れなければ従来の `/icon` に落ちる** (画像が消された公開プロジェクトでは今の画像が出る)", async () => {
    const {
      deps: d,
      calls,
      store,
    } = deps({
      [THUMB]: () => new Response(null, { status: 404 }),
      [ICON_API]: () => image("image/png"),
    });

    expect(await cardIcon("proj", "taro", d, ID)).toBe(PNG_URI);
    expect(calls.map((c) => c.url)).toEqual([THUMB, ICON_API]);
    // Gyazo の失敗は ID の鍵に、`/icon` の成功は (project, user) の鍵に
    expect(store.get(gyazoCacheKey(ID))).toEqual({ body: "", cacheControl: "max-age=3600" });
    expect(store.get(iconCacheKey("proj", "taro"))?.body).toBe(PNG_URI);
  });

  it("どちらも取れなければ undefined で、両方の失敗を記憶する", async () => {
    const {
      deps: d,
      calls,
      store,
    } = deps({
      [THUMB]: () => new Response(null, { status: 404 }),
      [ICON_API]: () => new Response(null, { status: 401 }),
    });

    expect(await cardIcon("proj", "taro", d, ID)).toBeUndefined();
    expect(store.get(gyazoCacheKey(ID))?.body).toBe("");
    expect(store.get(iconCacheKey("proj", "taro"))?.body).toBe("");

    expect(await cardIcon("proj", "taro", d, ID)).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("**Gyazo の転送先にも許可リストと、種類・大きさの検査がかかる**", async () => {
    const evil = deps({
      [THUMB]: () => redirect("https://evil.example/x.png"),
      [ICON_API]: () => new Response(null, { status: 401 }),
    });
    expect(await cardIcon("proj", "taro", evil.deps, ID)).toBeUndefined();
    expect(evil.calls.map((c) => c.url)).toEqual([THUMB, ICON_API]);

    const svg = deps({
      [THUMB]: () => redirect(FILE),
      [FILE]: () => image("image/svg+xml"),
      [ICON_API]: () => new Response(null, { status: 401 }),
    });
    expect(await cardIcon("proj", "taro", svg.deps, ID)).toBeUndefined();

    const big = deps({
      [THUMB]: () => redirect(FILE),
      [FILE]: () => image("image/png", new Uint8Array(MAX_ICON_BYTES + 1)),
      [ICON_API]: () => new Response(null, { status: 401 }),
    });
    expect(await cardIcon("proj", "taro", big.deps, ID)).toBeUndefined();
  });

  it("**形の外れた ID では URL を組み立てず、従来どおり `/icon` だけを引く**", async () => {
    for (const bad of ["../../etc/passwd", `${"0".repeat(31)}/`, "ABC", ""]) {
      const { deps: d, calls } = deps({ [ICON_API]: () => image("image/png") });
      expect(await cardIcon("proj", "taro", d, bad), bad).toBe(PNG_URI);
      expect(
        calls.map((c) => c.url),
        bad,
      ).toEqual([ICON_API]);
    }
  });

  it("**ID の鍵は外から引けない名前で、(project, user) の鍵とぶつからない** (project 名が `gyazo`、user 名が ID の形でも)", () => {
    expect(gyazoCacheKey(ID)).toBe(`https://card-icon-gyazo.invalid/${ID}`);
    expect(gyazoCacheKey(ID)).not.toBe(iconCacheKey("gyazo", ID));
  });
});
