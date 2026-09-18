import { describe, expect, it } from "vitest";
import { isValidProjectName, MAX_PROJECT_NAME_LENGTH } from "../../src/shared/project-name.ts";

describe("プロジェクト名の形", () => {
  it("英字・数字・ハイフンを通す", () => {
    for (const name of ["villagepump", "help-jp", "a", "9", "my-notes-2026", "A-b-9"]) {
      expect(isValidProjectName(name)).toBe(true);
    }
  });

  it("**ハイフンで始まったり終わったりするものは通さない** (Cosense が作らせない形)", () => {
    for (const name of ["-a", "a-", "-", "--", "-a-"]) {
      expect(isValidProjectName(name)).toBe(false);
    }
  });

  it("**英字・数字・ハイフン以外は通さない**", () => {
    for (const name of ["a_b", "日本語", "a b", "a.b", "a/b", "a@b"]) {
      expect(isValidProjectName(name)).toBe(false);
    }
  });

  it("**SVG を壊しうる文字はここで落ちる** (`escapeXml` に頼らず、先に形で弾く)", () => {
    for (const name of [
      '"><script>alert(1)</script>',
      "a<b",
      "a&b",
      'a"b',
      "a'b",
      "</text><script/>",
    ]) {
      expect(isValidProjectName(name)).toBe(false);
    }
  });

  it("空は通さない", () => {
    expect(isValidProjectName("")).toBe(false);
  });

  it("**上限ちょうどは通し、1 文字超えたら通さない**", () => {
    expect(isValidProjectName("a".repeat(MAX_PROJECT_NAME_LENGTH))).toBe(true);
    expect(isValidProjectName("a".repeat(MAX_PROJECT_NAME_LENGTH + 1))).toBe(false);
  });
});
