/**
 * Worker のエントリ。
 *
 * 段階 0 は骨組みだけ。経路は段階 1 で `/v1/g/{publicId}.svg`、
 * 段階 3 で `/v1/p.gif` を足す (docs/roadmap.md)。
 */
export default {
  async fetch(): Promise<Response> {
    return new Response("Not Found", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        // 経路が無いうちから付けておく。段階 1 以降の応答にも同じものを載せる。
        "x-content-type-options": "nosniff",
      },
    });
  },

  async scheduled(): Promise<void> {
    // 段階 3 で daybits の掃除を入れる (90 日より古い行を消す。ADR-0013 決定 2)。
  },
} satisfies ExportedHandler<Env>;
