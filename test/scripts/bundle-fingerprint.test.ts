import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bodyOf,
  buildId,
  FINGERPRINT_PREFIX,
  parseFingerprint,
  stamp,
} from "../../scripts/bundle-fingerprint.ts";

const BUNDLE = '// banner\n"use strict";\n(() => {})();\n';
const SOURCE = { commit: "6f1103c", date: "2026-10-08" };

describe("stamp", () => {
  it("先頭行に、本体の SHA-256 先頭 12 桁と commit を刻む", () => {
    const stamped = stamp(BUNDLE, SOURCE);
    const sha = createHash("sha256").update(BUNDLE.slice(0, -1)).digest("hex");
    expect(stamped).toBe(
      `${FINGERPRINT_PREFIX}${sha.slice(0, 12)} — commit 6f1103c (2026-10-08)\n${BUNDLE}`,
    );
  });

  it("commit が違っても、コードが同じなら build は同じ", () => {
    const a = parseFingerprint(stamp(BUNDLE, SOURCE));
    const b = parseFingerprint(stamp(BUNDLE, { commit: "abcdef0+dirty", date: "2026-10-09" }));
    expect(a?.build).toBe(b?.build);
    expect(b?.commit).toBe("abcdef0+dirty");
  });

  it("コードが 1 バイト違えば build も違う", () => {
    const a = parseFingerprint(stamp(BUNDLE, SOURCE));
    const b = parseFingerprint(stamp(BUNDLE.replace("{}", "{ }"), SOURCE));
    expect(a?.build).not.toBe(b?.build);
  });

  it("既に指紋があれば付け替える (2 行にならない)", () => {
    const again = stamp(stamp(BUNDLE, SOURCE), { ...SOURCE, commit: "abcdef0" });
    expect(again.split("\n").filter((line) => line.startsWith(FINGERPRINT_PREFIX))).toHaveLength(1);
    expect(parseFingerprint(again)?.build).toBe(parseFingerprint(stamp(BUNDLE, SOURCE))?.build);
  });
});

describe("bodyOf / buildId", () => {
  it("手元のバンドルと、末尾の改行が無い配信物で同じ値になる", () => {
    const stamped = stamp(BUNDLE, SOURCE);
    expect(bodyOf(stamped)).toBe(bodyOf(stamped.slice(0, -1)));
    expect(buildId(stamped)).toBe(buildId(stamped.slice(0, -1)));
  });

  it("指紋の行が無ければ、そのまま本体として扱う", () => {
    expect(bodyOf(BUNDLE)).toBe(BUNDLE.slice(0, -1));
  });
});

describe("parseFingerprint", () => {
  it("形の違う先頭行は読まない", () => {
    expect(parseFingerprint(BUNDLE)).toBeUndefined();
    expect(
      parseFingerprint(`${FINGERPRINT_PREFIX}xyz — commit 6f1103c (2026-10-08)\n`),
    ).toBeUndefined();
    // 2 行目以降にあっても読まない (先頭行だけが目印)
    expect(parseFingerprint(`x\n${stamp(BUNDLE, SOURCE)}`)).toBeUndefined();
  });
});
