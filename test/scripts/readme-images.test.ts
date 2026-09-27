import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  applyImages,
  framed,
  imgTag,
  LEDGER_PATH,
  type Ledger,
  PADDING,
  README_PATH,
  type ReadmeImage,
} from "../../scripts/readme-images.ts";

const shot = (name: string): ReadmeImage => ({
  name,
  path: `/v1/guide/${name}.svg`,
  alt: `${name} の図`,
  width: 672,
  sha256: "0".repeat(64),
  url: `https://i.gyazo.com/${name}.png`,
});

describe("applyImages", () => {
  it("**マーカーの次の行に <img> を挿し、既にあれば置き換える**", () => {
    const readme = [
      "# t",
      "<!-- readme-image: a -->",
      "",
      "<!-- readme-image: b -->",
      '<img src="https://i.gyazo.com/old.png" width="1" alt="古い">',
      "end",
    ].join("\n");

    expect(applyImages(readme, [shot("a"), shot("b")])).toBe(
      [
        "# t",
        "<!-- readme-image: a -->",
        imgTag(shot("a")),
        "",
        "<!-- readme-image: b -->",
        imgTag(shot("b")),
        "end",
      ].join("\n"),
    );
  });

  it("**書き戻しは冪等** (2 回当てても変わらない)", () => {
    const readme = "<!-- readme-image: a -->\n";
    const once = applyImages(readme, [shot("a")]);

    expect(applyImages(once, [shot("a")])).toBe(once);
  });

  it("**台帳にあって README に無いマーカーは投げる** (貼り忘れ)", () => {
    expect(() => applyImages("<!-- readme-image: a -->", [shot("a"), shot("b")])).toThrow(
      "台帳の b のマーカーが README に無い",
    );
  });

  it("**README にあって台帳に無いマーカーは投げる** (消し忘れ)", () => {
    expect(() => applyImages("<!-- readme-image: x -->", [])).toThrow("マーカー x が台帳");
  });

  it("**同じマーカーが 2 つあれば投げる**", () => {
    const readme = "<!-- readme-image: a -->\n<!-- readme-image: a -->";

    expect(() => applyImages(readme, [shot("a")])).toThrow("2 つある");
  });

  it("**まだ撮っていない画像は書き戻せない**", () => {
    const { url: _url, ...unshot } = shot("a");

    expect(() => applyImages("<!-- readme-image: a -->", [unshot])).toThrow("まだ撮っていない");
  });

  it("**alt の引用符は属性から漏れない**", () => {
    expect(imgTag({ ...shot("a"), alt: 'a "b" <c>' })).toContain('alt="a &quot;b&quot; &lt;c>"');
  });
});

describe("framed", () => {
  it("**白地と余白を付け、寸法は余白込みで返す**", () => {
    const frame = framed(
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="296"><g/></svg>',
    );

    expect(frame).toMatchObject({ width: 640 + PADDING * 2, height: 296 + PADDING * 2 });
    expect(frame.svg).toContain('fill="#ffffff"');
    expect(frame.svg).toContain(`<svg x="${PADDING}" y="${PADDING}" xmlns=`);
  });

  it("**寸法の無い SVG は投げる** (余白を付けられない)", () => {
    expect(() => framed('<svg viewBox="0 0 1 1"/>')).toThrow("width / height");
  });
});

// 台帳と README がずれていないこと (画像行を手で書き換えると落ちる)
describe("README と台帳", () => {
  it("**README の画像行は台帳から書き戻したとおり**", async () => {
    const ledger = JSON.parse(await readFile(LEDGER_PATH, "utf8")) as Ledger;
    const readme = await readFile(README_PATH, "utf8");

    expect(applyImages(readme, ledger.images)).toBe(readme);
  });
});
