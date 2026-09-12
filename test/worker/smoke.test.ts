import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// SELF と env は cloudflare:test が非推奨と注記しているが、後継の
// `cloudflare:workers` はこのインストールに型宣言が無い (research.md §5)。
// shared/ids の検証は test/shared/ids.test.ts が両環境で行う。

describe("Worker の骨組み", () => {
  it("経路がまだ無いので 404 を返す", async () => {
    const res = await SELF.fetch("https://example.com/");

    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("D1 の足場", () => {
  it("ローカルの D1 に接続できる", async () => {
    // wrangler.jsonc の database_id はプレースホルダだが、miniflare はこれを
    // ローカルの識別子としてしか使わないので段階 0 でも通る。
    const row = await env.DB.prepare("select 1 as ok").first<{ ok: number }>();

    expect(row?.ok).toBe(1);
  });
});

describe("secrets の足場", () => {
  it("テスト用のダミー値が env に入っている", () => {
    // secrets.required を宣言しているので値が無いと警告が出る。テストでは
    // vitest.worker.config.ts の miniflare.bindings が入ることを確かめる
    // (段階 4 の HMAC のテストの前提)。
    expect(env.WORKER_SECRET).toBe("test-worker-secret");
  });
});

describe("workerd の環境", () => {
  it("DOM は見えない", () => {
    // lib を分けている意図が実行時にも成り立っていることの確認。
    // `globalThis.document` と書くと workerd の lib に document が無いので
    // TS7017 になる (それ自体が分離が効いている証拠)。`in` で確かめる
    expect("document" in globalThis).toBe(false);
  });
});
