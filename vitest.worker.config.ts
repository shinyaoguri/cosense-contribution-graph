import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// workerd で走るテスト。**実 Cloudflare アカウントも API トークンも要らない**
// (CI が認証情報なしで green になることを不変条件にしている)。
//
// import は @cloudflare/vitest-plugin の**ルートから**行う。/config サブパスは
// 存在しない (公式ドキュメントに古い記述が残っている)。
export default defineConfig(async () => {
  const migrations = await readD1Migrations(join(import.meta.dirname, "migrations"));

  return {
    test: {
      name: "worker",
      // **test/shared は userscript project の include にも入っている。**
      // 同じファイルが workerd と jsdom で 2 回走り、shared が両環境で同じ答えを
      // 返すことを 1 つの検証で保証する
      include: ["test/worker/**/*.test.ts", "test/shared/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // secrets.required を宣言しているので、値が無いと毎回警告が出る。
            // **テスト用のダミー。実際の値は絶対に置かない** (ローカルは .dev.vars、
            // 本番は GitHub Actions から wrangler deploy --secrets-file で投入する)。
            WORKER_SECRET: "test-worker-secret",
            GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
            GOOGLE_CLIENT_SECRET: "test-client-secret",
          },
        },
      }),
    ],
  };
});
