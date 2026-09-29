import { describe, expect, it } from "vitest";
import {
  isValidProjectName,
  isValidUserName,
  MAX_PROJECT_NAME_LENGTH,
  MAX_USER_NAME_LENGTH,
} from "../../src/shared/project-name.ts";

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

describe("ユーザー名の形 (Issue #134・#195)", () => {
  it("英字・数字・ハイフンを通す", () => {
    for (const name of ["takker", "so", "user-01", "A9"]) {
      expect(isValidUserName(name)).toBe(true);
    }
  });

  it("**漢字・かな・空白・記号・絵文字も通す** (Cosense のユーザー名は英数字に収まらない。research §2)", () => {
    for (const name of [
      "山田太郎",
      "やまだ",
      "ヤマダ",
      "山田 太郎",
      "山田　太郎",
      "a_b",
      "-a",
      "a-",
      "a.b",
      "🌱",
      "👩‍💻",
      "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
      "❤️",
      "é",
    ]) {
      expect(isValidUserName(name)).toBe(true);
    }
  });

  it('**`<` `&` `"` も通す** (描くときに `escapeXml` を通す。形では落とさない)', () => {
    for (const name of ["a<b", "a&b", 'a"b', "a'b", "a>b"]) {
      expect(isValidUserName(name)).toBe(true);
    }
  });

  it("**制御文字・行や段落の区切りは通さない**", () => {
    for (const name of ["a\nb", "a\tb", "a\u0000b", "a\u007fb", "a\u2028b", "a\u2029b"]) {
      expect(isValidUserName(name)).toBe(false);
    }
  });

  it("**双方向の制御文字は通さない** (後ろの凡例まで並びを反転させうる)", () => {
    for (const c of [
      "\u061c",
      "\u200e",
      "\u200f",
      "\u202a",
      "\u202b",
      "\u202c",
      "\u202d",
      "\u202e",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
    ]) {
      expect(isValidUserName(`a${c}b`)).toBe(false);
    }
  });

  it("**片割れのサロゲートは通さない** (`encodeURIComponent` が投げる)", () => {
    for (const name of ["a\ud800", "\udc00b"]) {
      expect(isValidUserName(name)).toBe(false);
    }
  });

  it("空と、空白だけの名前は通さない", () => {
    for (const name of ["", " ", "　", " 　 "]) {
      expect(isValidUserName(name)).toBe(false);
    }
  });

  it("**上限は書記素で数える。ちょうどは通し、1 つ超えたら通さない**", () => {
    expect(isValidUserName("山".repeat(MAX_USER_NAME_LENGTH))).toBe(true);
    expect(isValidUserName("山".repeat(MAX_USER_NAME_LENGTH + 1))).toBe(false);
    // ZWJ でつないだ絵文字は 1 書記素 (UTF-16 で 5)
    expect(isValidUserName("👩‍💻".repeat(MAX_USER_NAME_LENGTH))).toBe(true);
  });

  it("**UTF-16 で 256 を超えたら、書記素が少なくても通さない** (URL を膨らませない)", () => {
    // 結合文字を重ねると 1 書記素のまま長くできる
    const base = "a";
    expect(isValidUserName(base + "\u0301".repeat(255))).toBe(true);
    expect(isValidUserName(base + "\u0301".repeat(256))).toBe(false);
  });
});
