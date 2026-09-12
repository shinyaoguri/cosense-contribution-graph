import { defineConfig } from "vitest/config";

// ブラウザ側のテスト。DOM が要るので jsdom。
// Workers plugin は載せない (workerd のグローバルと衝突する)。
export default defineConfig({
  test: {
    name: "userscript",
    // test/shared は worker project の include にも入っている (両環境で走らせる)
    include: ["test/userscript/**/*.test.ts", "test/shared/**/*.test.ts"],
    environment: "jsdom",
  },
});
