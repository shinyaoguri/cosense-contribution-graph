import { defineConfig } from "vitest/config";

// project を列挙するだけの薄いルート。実体は 2 ファイルに分かれている。
//
// Worker のテストは workerd 内で走るので document が無く、UserScript のテストは
// DOM が必要。公式も「Workers Vitest integration で custom environment は非対応」と
// 明記しているので、同じ project には混ぜられない。
export default defineConfig({
  test: {
    projects: ["vitest.worker.config.ts", "vitest.userscript.config.ts"],
  },
});
