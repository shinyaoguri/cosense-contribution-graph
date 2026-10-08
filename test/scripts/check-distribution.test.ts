import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stamp } from "../../scripts/bundle-fingerprint.ts";

const SCRIPT = join(import.meta.dirname, "../../scripts/check-distribution.sh");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const CODE = '// banner\n"use strict";\nrun();\n';
const source = (commit: string) => ({ commit, date: "2026-10-08" });

/**
 * 手元のバンドルと配信物 (`DISTRIBUTION_BASE=file://...` の `<page>/script.js`) を置いて走らせる。
 * 配信物は Cosense と同じく末尾の改行を持たない
 */
function check(bundle: string, served: string): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), "check-distribution-"));
  roots.push(root);
  mkdirSync(join(root, "dev"));
  writeFileSync(join(root, "dev/script.js"), served.replace(/\n$/, ""));
  writeFileSync(join(root, "bundle.js"), bundle);
  const result = spawnSync(SCRIPT, ["dev", join(root, "bundle.js")], {
    encoding: "utf8",
    env: {
      ...process.env,
      DISTRIBUTION_BASE: `file://${root}`,
      GITHUB_OUTPUT: "",
      GITHUB_STEP_SUMMARY: "",
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("check-distribution.sh", () => {
  it("同じものなら一致", () => {
    const bundle = stamp(CODE, source("6f1103c"));
    const { status, output } = check(bundle, bundle);
    expect(status, output).toBe(0);
    expect(output).not.toContain("注意");
  });

  it("commit だけ違う指紋は一致とみなす (比べるのは指紋の行を除いた本体)", () => {
    const { status, output } = check(
      stamp(CODE, source("6f1103c")),
      stamp(CODE, source("abcdef0")),
    );
    expect(status, output).toBe(0);
  });

  it("指紋の無い配信物でも、本体が同じなら一致", () => {
    const { status, output } = check(stamp(CODE, source("6f1103c")), CODE);
    expect(status, output).toBe(0);
    expect(output).toContain("(指紋なし)");
  });

  it("本体が違えば違うと言う", () => {
    const { status, output } = check(
      stamp(CODE, source("6f1103c")),
      stamp(`${CODE}more();\n`, source("6f1103c")),
    );
    expect(status, output).toBe(1);
  });

  it("配信物の指紋が本体と合わなければ注意を添える", () => {
    const bundle = stamp(CODE, source("6f1103c"));
    const tampered = bundle.replace("run();", "run(1);");
    const { output } = check(bundle, tampered);
    expect(output).toContain("注意: 配布ページの指紋");
  });
});
