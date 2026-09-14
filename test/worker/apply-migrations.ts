// Worker のテストファイルごとに D1 へマイグレーションを当てる (vitest.worker.config.ts の setupFiles)。
// 当て済みのものは d1_migrations に記録されるので、同じファイルで 2 回走っても重複しない
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
