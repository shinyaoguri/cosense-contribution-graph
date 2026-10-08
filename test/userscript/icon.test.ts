import { describe, expect, it } from "vitest";
import { createIconResolver, gyazoIdOf } from "../../src/userscript/icon.ts";

const ID = "0123456789abcdef0123456789abcdef";

describe("gyazoIdOf (ADR-0028)", () => {
  it("**Gyazo の URL から 32 桁の画像 ID を取り出す** (ページの `image` の形: `/raw`、元の URL、i.gyazo.com の拡張子付き)", () => {
    for (const image of [
      `https://gyazo.com/${ID}/raw`,
      `https://gyazo.com/${ID}`,
      `https://gyazo.com/${ID}/max_size/400`,
      `https://i.gyazo.com/${ID}.png`,
      `https://gyazo.com/${ID}?x=1`,
    ]) {
      expect(gyazoIdOf(image), image).toBe(ID);
    }
  });

  it("**Gyazo 以外・https でない・ID の形でないものは undefined** (Cosense のファイルや外部 URL は渡さない)", () => {
    for (const image of [
      null,
      undefined,
      "",
      "https://scrapbox.io/files/0123456789abcdef01234567.png",
      `http://gyazo.com/${ID}/raw`,
      `https://example.com/gyazo.com/${ID}/raw`,
      `https://gyazo.com.example.com/${ID}/raw`,
      `https://user@gyazo.com/${ID}/raw`,
      `https://gyazo.com/${ID.toUpperCase()}/raw`,
      `https://gyazo.com/${ID}0/raw`,
      "https://gyazo.com/short/raw",
      "https://i.gyazo.com/thumb_dpr/64/x-png.png",
    ]) {
      expect(gyazoIdOf(image), String(image)).toBeUndefined();
    }
  });
});

/** ページの応答を返す偽の fetchText。呼ばれた path を記録する */
function resolver(pages: Record<string, string | undefined | Error>) {
  const paths: string[] = [];
  const iconOf = createIconResolver({
    fetchText: async (path) => {
      paths.push(path);
      const body = pages[path];
      if (body instanceof Error) {
        throw body;
      }
      return body;
    },
  });
  return { iconOf, paths };
}

const page = (image: string | null, extra: object = {}) =>
  JSON.stringify({ id: "p1", persistent: true, image, lines: [], ...extra });

describe("createIconResolver", () => {
  it("**ログインしたブラウザで `/api/pages/<project>/<user>` を引き、`image` の Gyazo の ID を返す**", async () => {
    const t = resolver({ "/api/pages/proj/taro": page(`https://gyazo.com/${ID}/raw`) });

    expect(await t.iconOf("proj", "taro")).toBe(ID);
    expect(t.paths).toEqual(["/api/pages/proj/taro"]);
  });

  it("プロジェクト名とユーザー名は URL エンコードして path にする", async () => {
    const user = "太郎 & <x>";
    const path = `/api/pages/proj/${encodeURIComponent(user)}`;
    const t = resolver({ [path]: page(`https://gyazo.com/${ID}/raw`) });

    expect(await t.iconOf("proj", user)).toBe(ID);
    expect(t.paths).toEqual([path]);
  });

  it("**プロジェクトごとにこの読み込みの間だけ覚える。同時に頼んでも 1 回しか引かない**", async () => {
    const t = resolver({
      "/api/pages/a/taro": page(`https://gyazo.com/${ID}/raw`),
      "/api/pages/b/taro": page(null),
    });

    const [first, second] = await Promise.all([t.iconOf("a", "taro"), t.iconOf("a", "taro")]);
    expect(first).toBe(ID);
    expect(second).toBe(ID);
    expect(await t.iconOf("a", "taro")).toBe(ID);
    expect(await t.iconOf("b", "taro")).toBeUndefined();
    expect(await t.iconOf("b", "taro")).toBeUndefined();
    expect(t.paths).toEqual(["/api/pages/a/taro", "/api/pages/b/taro"]);
  });

  it("**ユーザー名が無ければ引かずに undefined** (未ログイン)", async () => {
    const t = resolver({});

    expect(await t.iconOf("proj", undefined)).toBeUndefined();
    expect(await t.iconOf("proj", "")).toBeUndefined();
    expect(t.paths).toEqual([]);
  });

  it("**画像なし・Gyazo でない・ページが無い・壊れた応答・通信の失敗は、どれも undefined で例外を出さない**", async () => {
    const t = resolver({
      "/api/pages/none/taro": page(null),
      "/api/pages/files/taro": page("https://scrapbox.io/files/0123456789abcdef01234567.png"),
      "/api/pages/missing/taro": undefined,
      "/api/pages/broken/taro": "{not json",
      "/api/pages/array/taro": "[]",
      "/api/pages/typed/taro": JSON.stringify({ image: 42 }),
      "/api/pages/down/taro": new TypeError("Failed to fetch"),
    });

    for (const project of ["none", "files", "missing", "broken", "array", "typed", "down"]) {
      expect(await t.iconOf(project, "taro"), project).toBeUndefined();
    }
  });

  it("**まだ保存されていないページ (`persistent: false`) は画像があっても使わない**", async () => {
    const t = resolver({
      "/api/pages/proj/taro": page(`https://gyazo.com/${ID}/raw`, { persistent: false }),
    });

    expect(await t.iconOf("proj", "taro")).toBeUndefined();
  });
});
