import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/shared/hash.ts";
import {
  PROBE_DIGEST_LENGTH,
  PROBE_WIDTH_BASE,
  type ProbeFlags,
  probeDigest,
  probeWidth,
  readProbeWidth,
} from "../../src/shared/probe.ts";

// Worker と UserScript で同じ値になることが前提なので、両環境で走らせる

describe("sha256Hex", () => {
  it("既知のベクタと一致する", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("UTF-8 でハッシュする", async () => {
    expect(await sha256Hex("草")).toBe(
      "91b246b5dbc05480de47cddceb027e7aa44ed3fd0bfdb745d5e0bdf6e7b4f1e7",
    );
  });

  it("桁数を指定すると先頭で切る", async () => {
    expect(await sha256Hex("abc", 32)).toBe("ba7816bf8f01cfea414140de5dae2223");
  });
});

describe("疎通確認の取り決め", () => {
  it("中身のハッシュは SHA-256 の先頭 32 桁", async () => {
    expect(PROBE_DIGEST_LENGTH).toBe(32);
    expect(await probeDigest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223");
  });

  const ALL_FLAGS: ProbeFlags[] = [false, true].flatMap((intact) =>
    [false, true].flatMap((referer) =>
      [false, true].map((notImageDest) => ({ intact, referer, notImageDest })),
    ),
  );

  it("8 通りのビットが幅 16〜23 に別々に対応し、読み戻せる", () => {
    const widths = ALL_FLAGS.map(probeWidth);

    expect(new Set(widths).size).toBe(8);
    expect(Math.min(...widths)).toBe(PROBE_WIDTH_BASE);
    expect(Math.max(...widths)).toBe(PROBE_WIDTH_BASE + 7);
    for (const flags of ALL_FLAGS) {
      expect(readProbeWidth(probeWidth(flags))).toEqual(flags);
    }
  });

  it("すべて正常なら幅 17 (中身一致だけが立つ)", () => {
    expect(probeWidth({ intact: true, referer: false, notImageDest: false })).toBe(17);
  });

  it("取り決めの外の幅は読まない (1×1 の画像を届いたと取り違えない)", () => {
    for (const width of [0, 1, 15, 24, 16.5, Number.NaN]) {
      expect(readProbeWidth(width), String(width)).toBeUndefined();
    }
  });
});
