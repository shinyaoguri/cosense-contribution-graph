import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "../../scripts/check-links.sh");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 最小のリポジトリを一時ディレクトリに作り、そこでスクリプトを走らせる。
 * スクリプトは自分の 1 つ上をルートとして検査するので、`scripts/` に写して置く。
 * ADR の索引の検査 (Issue #149) を通すため、ADR を 1 件とその一覧を置く。
 */
function check(files: Record<string, string>): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), "check-links-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  cpSync(SCRIPT, join(root, "scripts/check-links.sh"));
  const all: Record<string, string> = {
    "docs/decisions/0001-sample.md": "# ADR-0001\n",
    "docs/decisions/README.md": "- [ADR-0001](0001-sample.md)\n",
    "docs/other.md": "# 別のページ\n",
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const result = spawnSync("bash", [join(root, "scripts/check-links.sh")], { encoding: "utf8" });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("check-links.sh (Issue #121)", () => {
  it("実在するリンクは通る", () => {
    const { status } = check({ "docs/a.md": "[他のページ](other.md) と [見出し](other.md#x)\n" });

    expect(status).toBe(0);
  });

  it("壊れたリンクは落ちて、どのファイルのどのリンクかを出す", () => {
    const { status, output } = check({ "docs/a.md": "[無い](missing.md)\n" });

    expect(status).toBe(1);
    expect(output).toContain("docs/a.md -> missing.md");
  });

  it("**コードフェンスの中の正規表現はリンクとみなさない**", () => {
    const { status, output } = check({
      "docs/a.md": [
        "プロジェクト名の形:",
        "",
        "```",
        "^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$",
        "```",
        "",
      ].join("\n"),
    });

    expect(output).not.toContain("?:");
    expect(status).toBe(0);
  });

  it("**字下げされたフェンスと `~~~` のフェンスも同じ**", () => {
    const { status } = check({
      "docs/a.md": [
        "- 手順",
        "",
        "  ```sh",
        "  x[0](y)",
        "  ```",
        "",
        "~~~",
        "[a](b-missing.md)",
        "~~~",
        "",
      ].join("\n"),
    });

    expect(status).toBe(0);
  });

  it("**4 つのバッククォートのフェンスは、中の 3 つのフェンスで閉じない**", () => {
    const { status } = check({
      "docs/a.md": [
        "````markdown",
        "```",
        "[a](inner-missing.md)",
        "```",
        "[b](still-inside-missing.md)",
        "````",
        "",
      ].join("\n"),
    });

    expect(status).toBe(0);
  });

  it("**インラインコードの中も、リンクとみなさない**", () => {
    const { status } = check({ "docs/a.md": "書き方は `[x](missing.md)` のようにする\n" });

    expect(status).toBe(0);
  });

  it("**フェンスの外は検査を続ける** — 閉じた後の壊れたリンクは落ちる", () => {
    const { status, output } = check({
      "docs/a.md": ["```", "[a](inside.md)", "```", "", "[b](after-missing.md)", ""].join("\n"),
    });

    expect(status).toBe(1);
    expect(output).toContain("after-missing.md");
    expect(output).not.toContain("inside.md");
  });

  it("**リンクの文字にコードを含んでいても、リンク先は検査する**", () => {
    const { status, output } = check({ "docs/a.md": "[`code`](missing-target.md)\n" });

    expect(status).toBe(1);
    expect(output).toContain("missing-target.md");
  });
});
