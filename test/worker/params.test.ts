import { describe, expect, it } from "vitest";
import { CARD_FORM, GRAPH_FORM } from "../../src/shared/grass.ts";
import { parseGrassParams } from "../../src/worker/params.ts";

const parse = (query: string, defaults = CARD_FORM) =>
  parseGrassParams(new URLSearchParams(query), defaults);

describe("parseGrassParams (ADR-0026 決定 1)", () => {
  it("**既定の形は呼び出し側が渡す** (URL ごとに違う)", () => {
    expect(parse("").form).toEqual({ span: "half", cell: "slot" });
    expect(parse("", GRAPH_FORM).form).toEqual({ span: "year", cell: "day" });
    expect(parse("")).toEqual({
      form: CARD_FORM,
      theme: "light",
      mode: "bi",
      palette: "violet-amber",
      lang: "ja",
    });
  });

  it("span と cell は独立に選べる", () => {
    expect(parse("span=year").form).toEqual({ span: "year", cell: "slot" });
    expect(parse("cell=day").form).toEqual({ span: "half", cell: "day" });
    expect(parse("span=half&cell=slot", GRAPH_FORM).form).toEqual(CARD_FORM);
  });

  it("**外れた値は既定に落とす** (400 にしない)", () => {
    expect(parse("span=month&cell=hour").form).toEqual(CARD_FORM);
    expect(parse("span=YEAR&cell=").form).toEqual(CARD_FORM);
  });

  it("**year があれば span によらず 1 年**。右端はその年の 12/31", () => {
    expect(parse("year=2025")).toMatchObject({
      form: { span: "year", cell: "slot" },
      end: "2025-12-31",
    });
    expect(parse("year=2025&span=half").form.span).toBe("year");
    // 形の外れた year は無視する
    expect(parse("year=25").form.span).toBe("half");
    expect(parse("year=25")).not.toHaveProperty("end");
  });

  it("**weeks は読まない**", () => {
    expect(parse("weeks=53")).toEqual(parse(""));
    expect(parse("weeks=8", GRAPH_FORM).form).toEqual(GRAPH_FORM);
  });

  it("theme / mode / palette / lang を受ける", () => {
    expect(parse("theme=dark&mode=write&lang=en")).toMatchObject({
      theme: "dark",
      mode: "write",
      lang: "en",
    });
  });
});
