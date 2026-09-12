import { applyD1Migrations, env } from "cloudflare:test";

// ストレージの分離はテストファイル単位なので、ファイルごとにマイグレーションを当てる。
// migrations ディレクトリの中身は段階 3 で入る (今はコメントだけ)。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
