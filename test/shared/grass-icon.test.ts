import { describe, expect, it } from "vitest";
import { type GrassIconState, grassIconSvg } from "../../src/shared/grass-icon.ts";

describe("草のアイコン", () => {
  it("**単体で開ける SVG を返す** (favicon として配信するので名前空間が要る)", () => {
    const svg = grassIconSvg("synced");

    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 20 20"/);
    expect(svg).toMatch(/<\/svg>$/);
  });

  it("マスは 3×3 の 9 個", () => {
    const states: GrassIconState[] = ["unknown", "not-installed", "local-only", "synced"];
    for (const state of states) {
      expect(grassIconSvg(state).match(/<rect /g)).toHaveLength(9);
    }
  });

  it("**3 つの状態が別の絵になる** (アイコンだけで見分けられる)", () => {
    const icons = new Set(
      (["not-installed", "local-only", "synced"] as const).map((s) => grassIconSvg(s)),
    );

    expect(icons.size).toBe(3);
  });

  it("**判定の最中は `local-only` と同じ絵** (決まるまでちらつかせない)", () => {
    expect(grassIconSvg("unknown")).toBe(grassIconSvg("local-only"));
  });

  it("**数えていないときは塗らず、点線の枠だけ** (design §9 の「点線は計測開始前」と同じ使い方)", () => {
    const svg = grassIconSvg("not-installed");

    expect(svg).toContain("stroke-dasharray");
    expect(svg).not.toContain('fill="#');
  });

  it("送っているときは紫で塗る", () => {
    const svg = grassIconSvg("synced");

    expect(svg).toContain('fill="#7c3aed"');
    expect(svg).not.toContain("stroke-dasharray");
  });

  it("**スクリプトも外部参照も持たない** (favicon として直接開かれても何も読まない)", () => {
    for (const state of ["not-installed", "local-only", "synced"] as const) {
      const svg = grassIconSvg(state);
      expect(svg).not.toContain("<script");
      expect(svg).not.toContain("href");
    }
  });
});
