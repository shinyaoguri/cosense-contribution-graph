import { describe, expect, it } from "vitest";
import { PRIVACY_MARKDOWN } from "../../src/worker/privacy-source.ts";

describe("probe", () => {
  it("reads markdown", () => {
    expect(PRIVACY_MARKDOWN).toContain("プライバシー");
  });
});
