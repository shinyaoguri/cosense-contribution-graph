// cloudflare:test の env は Cloudflare.Env。本番のバインディング (DB / レート制限 /
// secrets) は worker-configuration.d.ts が既に宣言しているので、ここには
// **テスト専用のバインディングだけ**を interface 併合で足す。
// ambient (declare) なので erasableSyntaxOnly に抵触しない。
import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /** vitest.worker.config.ts の miniflare.bindings で注入する。 */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
