import { describe, expect, it } from "vitest";
import { USERSCRIPT_VERSION } from "../../src/userscript/index.ts";

// shared/ids の検証は test/shared/ids.test.ts が両環境で行う。

describe("UserScript の骨組み", () => {
  it("DOM が使える環境で走っている", () => {
    expect(typeof document).toBe("object");
  });

  it("版を名乗る", () => {
    expect(USERSCRIPT_VERSION).toBe("0.0.0");
  });
});
