import { describe, expect, it } from "vitest";
import { probeDigest } from "../../src/shared/probe.ts";
import {
  describeResult,
  type ProbeResult,
  probeUrl,
  randomPayload,
  type SendOptions,
  sendProbe,
  WORKER_ORIGIN,
} from "../../src/userscript/probe.ts";

type FakeImage = NonNullable<ReturnType<NonNullable<SendOptions["createImage"]>>> & {
  readonly writes: string[];
};

/** 設定された順番を記録する偽の画像。`src` を入れても何も読みに行かない。 */
function fakeImage(naturalWidth = 0): FakeImage {
  const writes: string[] = [];
  let referrerPolicy = "";
  let src = "";
  return {
    writes,
    naturalWidth,
    onload: null,
    onerror: null,
    get referrerPolicy() {
      return referrerPolicy;
    },
    set referrerPolicy(value: string) {
      writes.push("referrerPolicy");
      referrerPolicy = value;
    },
    get src() {
      return src;
    },
    set src(value: string) {
      writes.push("src");
      src = value;
    },
  } as FakeImage;
}

describe("送る中身", () => {
  it("base64url の文字だけで、指定した長さ", () => {
    const payload = randomPayload(15_000);

    expect(payload).toHaveLength(15_000);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("毎回違う", () => {
    expect(randomPayload(240)).not.toBe(randomPayload(240));
  });

  it("URL は本番の Worker の /v1/probe.gif に、版・中身・中身のハッシュを載せる", async () => {
    const payload = randomPayload(240);

    const url = new URL(await probeUrl(payload));

    expect(url.origin).toBe(WORKER_ORIGIN);
    expect(url.pathname).toBe("/v1/probe.gif");
    expect(url.searchParams.get("v")).toBe("1");
    expect(url.searchParams.get("d")).toBe(payload);
    expect(url.searchParams.get("h")).toBe(await probeDigest(payload));
    // それ以外は送らない (プロジェクト名もページ名も載せない)
    expect([...url.searchParams.keys()].sort()).toEqual(["d", "h", "v"]);
  });
});

describe("画像 GET で送る", () => {
  it("**referrerPolicy を src より先に設定する**", async () => {
    const image = fakeImage(17);

    const pending = sendProbe("https://example.com/v1/probe.gif", { createImage: () => image });
    image.onload?.();
    await pending;

    expect(image.writes).toEqual(["referrerPolicy", "src"]);
    expect(image.referrerPolicy).toBe("no-referrer");
  });

  it("読めたら幅からビットを読む", async () => {
    const image = fakeImage(17);

    const pending = sendProbe("https://example.com/", { createImage: () => image });
    image.onload?.();

    expect(await pending).toEqual({
      kind: "loaded",
      flags: { intact: true, referer: false, notImageDest: false },
    });
  });

  it("読めても幅が取り決めの外なら、届いたとみなさない", async () => {
    const image = fakeImage(1);

    const pending = sendProbe("https://example.com/", { createImage: () => image });
    image.onload?.();

    expect(await pending).toEqual({ kind: "unexpected", width: 1 });
  });

  it("読めなければ error", async () => {
    const image = fakeImage();

    const pending = sendProbe("https://example.com/", { createImage: () => image });
    image.onerror?.();

    expect(await pending).toEqual({ kind: "error" });
  });

  it("応答が無ければ打ち切る", async () => {
    const image = fakeImage();

    const result = await sendProbe("https://example.com/", {
      createImage: () => image,
      timeoutMs: 5,
    });

    expect(result).toEqual({ kind: "timeout" });
    expect(image.onload).toBeNull();
  });
});

describe("結果の表示", () => {
  it.each<[ProbeResult, string]>([
    [
      { kind: "loaded", flags: { intact: true, referer: false, notImageDest: false } },
      "届いた / 中身一致 / Referer なし / Sec-Fetch-Dest: image",
    ],
    [
      { kind: "loaded", flags: { intact: false, referer: true, notImageDest: true } },
      "届いた / ★中身が違う / ★Referer あり / ★Sec-Fetch-Dest が image 以外",
    ],
    [{ kind: "unexpected", width: 1 }, "★画像は読めたが幅が想定外 (1)"],
    [{ kind: "error" }, "★届かなかった (画像として読めない)"],
    [{ kind: "timeout" }, "★15 秒で応答が無い"],
  ])("%j", (result, text) => {
    expect(describeResult(result)).toBe(text);
  });
});
