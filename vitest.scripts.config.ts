import { defineConfig } from "vitest/config";

// scripts/ のテスト。手元でだけ走らせるコマンド (配布ページへの貼り付けなど) なので、
// DOM も workerd も要らない素の node で走らせる。
export default defineConfig({
  test: {
    name: "scripts",
    include: ["test/scripts/**/*.test.ts"],
    environment: "node",
  },
});
