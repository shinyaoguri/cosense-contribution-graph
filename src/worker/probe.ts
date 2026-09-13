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
    return new Response("Bad Request", {
      status: 400,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  const flags: ProbeFlags = {
    intact: (await probeDigest(payload)) === digest,
    referer: request.headers.has("referer"),
    notImageDest: request.headers.get("sec-fetch-dest") !== "image",
  };
  const width = probeWidth(flags);

  // Workers Logs に 1 行。**IP・UA・中身は出さない**
  console.log(JSON.stringify({ event: "probe", bytes: payload.length, flags: width }));

  return new Response(transparentGif(width), {
    status: 200,
    headers: {
      "content-type": "image/gif",
      // 送るたびに URL が変わるので効かないが、途中で保存させない意思を示す
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

// LZW の最小コードサイズ 2 のときのクリアコードと終了コード。コードは 3 bit
const LZW_MIN_CODE_SIZE = 2;
const LZW_CLEAR = 4;
const LZW_END = 5;
const LZW_CODE_BITS = 3;
const SUB_BLOCK_MAX = 255;

/**
 * 幅 `width` × 高さ 1 の透過 GIF。
 *
 * **LZW は画素ごとにクリアコードを挟む非圧縮形式にする。** 辞書が育たないのでコードは常に 3 bit で、
 * 圧縮器を書かずに済む。幅 1 のときは広く使われている 43 バイトの透過 GIF と同じバイト列になる
 * (段階 3 の `/v1/p.gif` もこれを返す)。
 */
export function transparentGif(width: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(width) || width < 1 || width > 0xffff) {
    throw new RangeError(`GIF の幅は 1〜65535: ${width}`);
  }

  const codes = [...Array.from({ length: width }, () => [LZW_CLEAR, 0]).flat(), LZW_END];
  const data: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const code of codes) {
    // GIF の LZW は LSB から詰める
    buffer |= code << bits;
    bits += LZW_CODE_BITS;
    while (bits >= 8) {
      data.push(buffer & 0xff);
      buffer >>= 8;
      bits -= 8;
    }
  }
  if (bits > 0) {
    data.push(buffer & 0xff);
  }

  const subBlocks: number[] = [];
  for (let i = 0; i < data.length; i += SUB_BLOCK_MAX) {
    const block = data.slice(i, i + SUB_BLOCK_MAX);
    subBlocks.push(block.length, ...block);
  }

  const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  return new Uint8Array([
    // ヘッダ
    ...[0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // "GIF89a"
    // 論理画面: 幅・高さ・グローバルカラーテーブルあり (2 色)・背景色 0・縦横比 0
    ...le16(width),
    ...le16(1),
    0x80,
    0x00,
    0x00,
    // グローバルカラーテーブル: 黒・白
    ...[0x00, 0x00, 0x00, 0xff, 0xff, 0xff],
    // グラフィック制御拡張: 色 0 を透過にする
    ...[0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00],
    // 画像記述子: 左上 (0, 0)・幅・高さ・ローカルカラーテーブルなし
    0x2c,
    ...le16(0),
    ...le16(0),
    ...le16(width),
    ...le16(1),
    0x00,
    // 画像データ
    LZW_MIN_CODE_SIZE,
    ...subBlocks,
    0x00,
    // 終端
    0x3b,
  ]);
}
