import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/shared/hash.ts";
import { handleProbe, transparentGif } from "../../src/worker/probe.ts";

const ORIGIN = "https://example.com";

async function probeRequest(
  query: Record<string, string>,
  headers: Record<string, string> = { "sec-fetch-dest": "image" },
): Promise<Response> {
  const url = new URL("/v1/probe.gif", ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return handleProbe(new Request(url, { headers }), url);
}

async function validQuery(payload: string): Promise<Record<string, string>> {
  return { v: "1", d: payload, h: await sha256Hex(payload, 32) };
}

/** GIF の論理画面の幅 (6〜7 バイト目、リトルエンディアン)。 */
async function gifWidth(res: Response): Promise<number> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  return (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /v1/probe.gif — 届いたリクエストを GIF の幅で返す", () => {
  it("中身が一致し、Referer が無く、Sec-Fetch-Dest が image なら幅 17", async () => {
    const res = await probeRequest(await validQuery("abc"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await gifWidth(res)).toBe(17);
  });

  it("ハッシュが中身と違えば、中身一致のビットが落ちて幅 16", async () => {
    const res = await probeRequest({ v: "1", d: "abc", h: "0".repeat(32) });

    expect(res.status).toBe(200);
    expect(await gifWidth(res)).toBe(16);
  });

  it("Referer が届けば +2", async () => {
    const res = await probeRequest(await validQuery("abc"), {
      "sec-fetch-dest": "image",
      referer: "https://scrapbox.io/project/page",
    });

    expect(await gifWidth(res)).toBe(19);
  });

  it("Sec-Fetch-Dest が image 以外 (無い場合も) なら +4", async () => {
    expect(await gifWidth(await probeRequest(await validQuery("abc"), {}))).toBe(21);
    expect(
      await gifWidth(await probeRequest(await validQuery("abc"), { "sec-fetch-dest": "empty" })),
    ).toBe(21);
  });

  it("上限の近く (15,000 文字) も受ける", async () => {
    const payload = "A".repeat(15_000);

    expect(await gifWidth(await probeRequest(await validQuery(payload)))).toBe(17);
  });

  it("ログに中身を出さない", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const payload = "secretlike_payload-123";

    await probeRequest(await validQuery(payload));

    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({ event: "probe", bytes: payload.length, flags: 17 });
    expect(line).not.toContain(payload);
  });
});

describe("形が不正なら 400 で画像を返さない (onerror になる)", () => {
  it.each([
    ["v が無い", { d: "abc", h: "ba7816bf8f01cfea414140de5dae2223" }],
    ["v が違う", { v: "2", d: "abc", h: "ba7816bf8f01cfea414140de5dae2223" }],
    ["d が無い", { v: "1", h: "ba7816bf8f01cfea414140de5dae2223" }],
    ["d が空", { v: "1", d: "", h: "e3b0c44298fc1c149afbf4c8996fb924" }],
    ["d に base64url 以外", { v: "1", d: "ab+c", h: "0".repeat(32) }],
    ["d が上限を超える", { v: "1", d: "A".repeat(16_385), h: "0".repeat(32) }],
    ["h が無い", { v: "1", d: "abc" }],
    ["h が大文字", { v: "1", d: "abc", h: "BA7816BF8F01CFEA414140DE5DAE2223" }],
    ["h の桁が足りない", { v: "1", d: "abc", h: "ba7816bf8f01cfea414140de5dae222" }],
  ])("%s", async (_, query) => {
    const res = await probeRequest(query);

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });
});

describe("経路", () => {
  it("/v1/probe.gif に届く", async () => {
    const payload = "route";
    const query = new URLSearchParams(await validQuery(payload));

    const res = await SELF.fetch(`${ORIGIN}/v1/probe.gif?${query}`, {
      headers: { "sec-fetch-dest": "image" },
    });

    expect(res.status).toBe(200);
    expect(await gifWidth(res)).toBe(17);
  });
});

describe("透過 GIF", () => {
  it("幅 1 は広く使われている 43 バイトの透過 GIF と同じバイト列", () => {
    expect([...transparentGif(1)]).toEqual([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00,
      0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00,
      0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
    ]);
  });

  /** 画像データの LZW を 3 bit ずつ読んだコードの列。 */
  function lzwCodes(gif: Uint8Array): number[] {
    // ヘッダ 6 + 論理画面 7 + カラーテーブル 6 + 制御拡張 8 + 画像記述子 10 + 最小コードサイズ 1
    let offset = 38;
    const data: number[] = [];
    for (let size = gif[offset] ?? 0; size > 0; size = gif[offset] ?? 0) {
      data.push(...gif.slice(offset + 1, offset + 1 + size));
      offset += 1 + size;
    }
    const codes: number[] = [];
    for (let bit = 0; bit + 3 <= data.length * 8; bit += 3) {
      const byte = (i: number) => data[i] ?? 0;
      const word = byte(bit >> 3) | (byte((bit >> 3) + 1) << 8);
      codes.push((word >> (bit % 8)) & 0b111);
    }
    return codes;
  }

  it.each([16, 17, 23, 1000])(
    "幅 %i: 画面と画像の幅が一致し、画素ごとにクリアコードを挟む (1000 はサブブロックが分かれる)",
    (width) => {
      const gif = transparentGif(width);
      const le16 = (i: number) => (gif[i] ?? 0) | ((gif[i + 1] ?? 0) << 8);

      expect(new TextDecoder().decode(gif.slice(0, 6))).toBe("GIF89a");
      expect(le16(6)).toBe(width);
      expect(le16(8)).toBe(1);
      expect(gif[27]).toBe(0x2c);
      expect(le16(32)).toBe(width);
      expect(le16(34)).toBe(1);
      expect(gif.at(-1)).toBe(0x3b);

      const codes = lzwCodes(gif);
      const end = codes.indexOf(5);
      expect(codes.slice(0, end)).toEqual(Array.from({ length: width }, () => [4, 0]).flat());
    },
  );

  it("幅が範囲外なら投げる", () => {
    for (const width of [0, 1.5, 65_536]) {
      expect(() => transparentGif(width), String(width)).toThrow(RangeError);
    }
  });
});
