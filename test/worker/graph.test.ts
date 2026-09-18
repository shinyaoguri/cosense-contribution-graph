import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEMO_TODAY, demoData } from "../../src/worker/demo.ts";
import { balanceOf, centerOf } from "../../src/worker/graph/balance.ts";
import { DEFAULT_PARAMS, gridCells, MAX_WEEKS } from "../../src/worker/graph/grid.ts";
import { buildScale, levelOf } from "../../src/worker/graph/scale.ts";
import {
  DEFAULT_SCHEME,
  SCHEMES,
  type SchemeName,
  schemeOf,
  type Theme,
} from "../../src/worker/graph/scheme.ts";
import { renderGraph } from "../../src/worker/svg.ts";

const SCHEME_NAMES = Object.keys(SCHEMES) as SchemeName[];

const DEMO_URL = "https://example.com/v1/g/demo.svg";

function fetchDemo(query = "", init?: RequestInit) {
  return SELF.fetch(`${DEMO_URL}${query}`, init);
}

/** ルート要素の属性。workerd には DOMParser が無いので正規表現で見る。 */
function rootAttributes(svg: string): Record<string, string> {
  const open = /^<svg\b([^>]*)>/.exec(svg);
  if (!open?.[1]) {
    throw new Error("ルート要素が <svg で始まっていない");
  }
  return Object.fromEntries(
    [...open[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
}

/** `<g data-part="...">` の中身。グループは入れ子にしていない。 */
function part(svg: string, name: string): string {
  return new RegExp(`<g data-part="${name}"[^>]*>(.*?)</g>`).exec(svg)?.[1] ?? "";
}

function fills(fragment: string): string[] {
  return [...fragment.matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1] ?? "");
}

function rectCount(fragment: string): number {
  return fragment.match(/<rect\b/g)?.length ?? 0;
}

describe("GET /v1/g/demo.svg の応答", () => {
  it("200 と、Cosense で表示されるのに要るヘッダ", async () => {
    const res = await fetchDemo();

    expect(res.status).toBe(200);
    // これが無いと Cosense で表示されない (research §3 で過去に踏まれた唯一の落とし穴)
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=900");
    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("HEAD でも 200 を返す", async () => {
    expect((await fetchDemo("", { method: "HEAD" })).status).toBe(200);
  });
});

describe("ETag (本文の SHA-256、ADR-0015 決定 2)", () => {
  it("強い ETag を付ける", async () => {
    const res = await fetchDemo();

    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it("If-None-Match が一致すれば 304。ETag と Cache-Control を付け、本文は空", async () => {
    const etag = (await fetchDemo()).headers.get("etag") ?? "";

    const res = await fetchDemo("", { headers: { "if-none-match": etag } });

    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe("public, max-age=900");
    expect(await res.text()).toBe("");
  });

  it("弱い比較: W/ 付きでも一致とみなす (Cloudflare が圧縮時に弱い ETag に変えることがある)", async () => {
    const etag = (await fetchDemo()).headers.get("etag") ?? "";

    const res = await fetchDemo("", { headers: { "if-none-match": `W/${etag}` } });

    expect(res.status).toBe(304);
  });

  it("一致しなければ 200", async () => {
    const res = await fetchDemo("", { headers: { "if-none-match": '"0000"' } });

    expect(res.status).toBe(200);
  });

  it("描画が変わると ETag も変わる (テーマを変えた場合)", async () => {
    const light = (await fetchDemo()).headers.get("etag");
    const dark = (await fetchDemo("?theme=dark")).headers.get("etag");

    expect(dark).not.toBe(light);
  });
});

describe("クエリ (design §6)", () => {
  it("不正な値と範囲外は既定値に落とす (ETag が既定と同じになる)", async () => {
    const defaultEtag = (await fetchDemo()).headers.get("etag");

    for (const query of [
      "?theme=blue",
      "?mode=read",
      "?weeks=0",
      "?weeks=54",
      "?weeks=10abc",
      "?weeks=-3",
      "?palette=unknown",
      "?palette=",
      "?palette=toString",
      "?palette=__proto__",
      "?unknown=1",
    ]) {
      expect((await fetchDemo(query)).headers.get("etag"), query).toBe(defaultEtag);
    }
  });

  it("既定の配色を palette で明示しても同じ画像", async () => {
    const defaultEtag = (await fetchDemo()).headers.get("etag");

    expect((await fetchDemo(`?palette=${DEFAULT_SCHEME}`)).headers.get("etag")).toBe(defaultEtag);
  });

  it("登録済みの palette はそれぞれ違う画像になる", async () => {
    const etags = await Promise.all(
      SCHEME_NAMES.map(async (name) => (await fetchDemo(`?palette=${name}`)).headers.get("etag")),
    );

    expect(new Set(etags).size).toBe(SCHEME_NAMES.length);
  });

  it("範囲内の weeks は反映する", async () => {
    const svg = await (await fetchDemo("?weeks=10")).text();

    expect(rectCount(part(svg, "grid"))).toBe(7 * 9 + 1);
  });
});

describe("存在しない経路は 404 (design §6)", () => {
  it("demo 以外の publicId", async () => {
    expect((await SELF.fetch("https://example.com/v1/g/unknown.svg")).status).toBe(404);
  });

  it("拡張子が違う", async () => {
    expect((await SELF.fetch("https://example.com/v1/g/demo.png")).status).toBe(404);
  });

  it("GET と HEAD 以外", async () => {
    expect((await fetchDemo("", { method: "POST" })).status).toBe(404);
  });
});

describe("SVG の構造", () => {
  it("ルート要素に xmlns / width / height / viewBox を持ち、viewBox が寸法に一致する", async () => {
    const attrs = rootAttributes(await (await fetchDemo()).text());

    expect(attrs.xmlns).toBe("http://www.w3.org/2000/svg");
    expect(attrs.viewBox).toBe(`0 0 ${attrs.width} ${attrs.height}`);
  });

  it(`格子は 365 マス、凡例は 5 列 × 4 行 = 20 マス`, async () => {
    const svg = await (await fetchDemo()).text();

    expect(rectCount(part(svg, "grid"))).toBe(365);
    expect(rectCount(part(svg, "legend"))).toBe(20);
  });

  it("write の凡例は 1 行 × 4 マス (バランスが 0 の 1 列なので 2 次元にしない)", async () => {
    const svg = await (await fetchDemo("?mode=write")).text();

    expect(rectCount(part(svg, "grid"))).toBe(365);
    expect(rectCount(part(svg, "legend"))).toBe(4);
  });

  it("月と曜日と凡例の軸のラベルを日本語で出す", async () => {
    const labels = part(await (await fetchDemo()).text(), "labels");

    const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
    for (const text of ["9月", "1月", ...weekdays, "読む", "書く", "少ない", "多い"]) {
      expect(labels).toContain(`>${text}</text>`);
    }
  });

  it("CSS の oklch() も外部参照も含まない (design §7 / §8)", async () => {
    const svg = await (await fetchDemo()).text();

    expect(svg).not.toMatch(/oklch\(/);
    expect(svg).not.toMatch(/href=|url\(|@import/);
  });
});

describe.each(SCHEME_NAMES)("palette=%s の格子", (name) => {
  const { days, population } = demoData();
  const scale = buildScale(population.map((d) => d.w + d.r));
  const center = centerOf(population);
  const scheme = schemeOf(name);

  /** 表示範囲のマスを、スキームにバランスを渡して塗った色。 */
  function expectedGrid(balanceOfDay: (minutes: { w: number; r: number }) => number): string[] {
    return gridCells(DEMO_TODAY, MAX_WEEKS).map((cell) => {
      const minutes = days.get(cell.day) ?? { w: 0, r: 0 };
      const total = minutes.w + minutes.r;
      const level = levelOf(total, scale);
      return scheme.cell({ level, balance: balanceOfDay(minutes), total }, "light");
    });
  }

  it("指定した配色で塗る", async () => {
    const grid = fills(part(await (await fetchDemo(`?palette=${name}`)).text(), "grid"));

    expect(grid).toEqual(expectedGrid((minutes) => balanceOf(minutes, center)));
  });

  it("write モードは**全マスのバランスを 0 とみなして塗る** (描画側が 0 を渡していること)", async () => {
    // スキームの側でバランス 0 の色を確かめても、描画側が 0 を渡していなければ意味が無い。
    // 描画側の配線を、スキームにバランス 0 を渡した色と突き合わせて固定する
    const svg = await (await fetchDemo(`?palette=${name}&mode=write`)).text();

    expect(fills(part(svg, "grid"))).toEqual(expectedGrid(() => 0));
    expect(rectCount(part(svg, "legend"))).toBe(4);
  });
});

describe("デモの草", () => {
  it("既定の配色の列 (凡例の見本) がすべて格子に出る", async () => {
    // 読み書きの割合が偏ると間の列が出ず、見た目の確認にならない
    const scheme = schemeOf(DEFAULT_SCHEME);
    const grid = fills(part(await (await fetchDemo()).text(), "grid"));

    for (const balance of scheme.legendBalances) {
      const column = new Set(
        ([1, 2, 3, 4] as const).map((level) => scheme.cell({ level, balance, total: 99 }, "light")),
      );
      const days = grid.filter((fill) => column.has(fill)).length;
      expect(days, `balance=${balance}`).toBeGreaterThanOrEqual(30);
    }
  });
});

describe.each(SCHEME_NAMES)("palette=%s の凡例 (スキームから組み立てる)", (name) => {
  /** 凡例は 行 = Level 1〜4、列 = スキームのバランスの見本。マスは飽和させる (total = Infinity)。 */
  function expectedLegend(theme: Theme): string[] {
    const scheme = schemeOf(name);
    return ([1, 2, 3, 4] as const).flatMap((level) =>
      scheme.legendBalances.map((balance) =>
        scheme.cell({ level, balance, total: Number.POSITIVE_INFINITY }, theme),
      ),
    );
  }

  it("ライトの凡例は、スキームの Level × バランスの見本の色", async () => {
    const legend = fills(part(await (await fetchDemo(`?palette=${name}`)).text(), "legend"));

    expect(legend).toEqual(expectedLegend("light"));
  });

  it("ダークの凡例はダークの色", async () => {
    const svg = await (await fetchDemo(`?palette=${name}&theme=dark`)).text();

    expect(fills(part(svg, "legend"))).toEqual(expectedLegend("dark"));
  });
});

describe("表示範囲と母集団を取り違えない (design §7)", () => {
  it("四分位を母集団 (全期間) から取った SVG と、表示範囲だけから取った SVG は違う", () => {
    const { days, population } = demoData();
    const params = DEFAULT_PARAMS;
    const center = centerOf(population);

    const fromPopulation = renderGraph({
      today: DEMO_TODAY,
      days,
      scale: buildScale(population.map((d) => d.w + d.r)),
      center,
      params,
    });
    const fromDisplayOnly = renderGraph({
      today: DEMO_TODAY,
      days,
      scale: buildScale([...days.values()].map((d) => d.w + d.r)),
      center,
      params,
    });

    // デモは表示範囲より古い日を分布を変えて母集団に入れてあるので、取り違えると色が変わる
    expect(fromPopulation).not.toBe(fromDisplayOnly);
  });

  it("経路は母集団 (全期間) から取った四分位で描く", async () => {
    const { days, population } = demoData();
    const expected = renderGraph({
      today: DEMO_TODAY,
      days,
      scale: buildScale(population.map((d) => d.w + d.r)),
      center: centerOf(population),
      params: DEFAULT_PARAMS,
    });

    expect(await (await fetchDemo()).text()).toBe(expected);
  });

  it("weeks が小さいと全体の幅は凡例で決まる", () => {
    const { days, population } = demoData();
    const svg = renderGraph({
      today: DEMO_TODAY,
      days,
      scale: buildScale(population.map((d) => d.w + d.r)),
      center: centerOf(population),
      params: { ...DEFAULT_PARAMS, weeks: 1 },
    });

    expect(Number(rootAttributes(svg).width)).toBeGreaterThan(8 * 2 + 20 + 11);
    expect(MAX_WEEKS).toBe(53);
  });
});

describe("プロジェクト名 (Issue #119)", () => {
  it("**`?l=` で渡された名前を描く**", async () => {
    const svg = await (await fetchDemo("?l=villagepump")).text();

    expect(svg).toContain(">villagepump</text>");
    expect(svg).toContain('font-weight="bold"');
  });

  it("**渡さなければ描かない**", async () => {
    const svg = await (await fetchDemo()).text();

    expect(svg).not.toContain("font-weight");
  });

  it("**形の違う名前は描かない** (エラーにはせず、名前だけ落とす)", async () => {
    for (const raw of ["-a", "a_b", "a b", "日本語", "a".repeat(65), ""]) {
      const res = await fetchDemo(`?l=${encodeURIComponent(raw)}`);
      const svg = await res.text();

      expect(res.status).toBe(200);
      expect(svg).not.toContain("font-weight");
    }
  });

  it("**SVG を壊そうとする値も描かない** (形で落ちるので `escapeXml` の出番が来ない)", async () => {
    const attack = '"><script>alert(1)</script>';

    const svg = await (await fetchDemo(`?l=${encodeURIComponent(attack)}`)).text();

    expect(svg).not.toContain("script");
    expect(svg).not.toContain("alert");
  });

  it("**名前が違えば ETag も違う** (本文から作るので自動で追従する)", async () => {
    const a = await fetchDemo("?l=aaa");
    const b = await fetchDemo("?l=bbb");
    const none = await fetchDemo();

    const etags = [a, b, none].map((res) => res.headers.get("etag"));
    expect(new Set(etags).size).toBe(3);
  });
});
