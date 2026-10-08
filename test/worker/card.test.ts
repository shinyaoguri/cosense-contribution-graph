import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CARD_FORM, CELLS, GRASS_SIZES, SPANS } from "../../src/shared/grass.ts";
import { PH_ALL, publicIdOf } from "../../src/shared/ids.ts";
import { DEMO_ICON } from "../../src/worker/demo.ts";
import { centerOf } from "../../src/worker/graph/balance.ts";
import { type GrassDay, type GrassInput, slotPopulation } from "../../src/worker/graph/grass.ts";
import { buildScale } from "../../src/worker/graph/scale.ts";
import { DEFAULT_SCHEME } from "../../src/worker/graph/scheme.ts";
import { type GrassOptions, renderStoredGrass } from "../../src/worker/graph-data.ts";
import { renderGrass } from "../../src/worker/grass-svg.ts";
import { randomUid } from "./beacon-helpers.ts";

// 2026-09-14 15:30 UTC は日本時間で 2026-09-15 (火) の 0:30。「今日」は Asia/Tokyo で決まる
const NOW = Date.parse("2026-09-14T15:30:00Z");
const TODAY = "2026-09-15";
const PH = "0123456789abcdef";
const DEMO_URL = "https://example.com/v1/g/demo/card.svg";
const CARD_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
const OPTIONS: GrassOptions = {
  form: CARD_FORM,
  theme: "light",
  mode: "bi",
  palette: DEFAULT_SCHEME,
  lang: "ja",
};
const ICON = "data:image/png;base64,iVBORw0KGgo=";

/** day, w, r, wc, wo, 区間 (sw0..sw3, sr0..sr3。null は内訳なし) */
type Row = readonly [
  day: string,
  w: number,
  r: number,
  wc: number,
  wo: number,
  segments: readonly number[] | null,
];

async function store(uid: string, ph: string, rows: readonly Row[]): Promise<string> {
  const publicId = await publicIdOf(uid, ph);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO graphs (public_id, uid, ph) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    ).bind(publicId, uid, ph),
    ...rows.map(([day, w, r, wc, wo, segments]) =>
      env.DB.prepare(
        "INSERT INTO daily (uid, ph, day, w, r, wc, wo, sw0, sw1, sw2, sw3, sr0, sr1, sr2, sr3) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(uid, ph, day, w, r, wc, wo, ...(segments ?? Array(8).fill(null))),
    ),
  ]);
  return publicId;
}

function cardDayOf([, w, r, wc, wo, s]: Row): GrassDay {
  return s === null
    ? { w, r, wc, wo }
    : {
        w,
        r,
        wc,
        wo,
        segments: {
          w: [s[0] ?? 0, s[1] ?? 0, s[2] ?? 0, s[3] ?? 0],
          r: [s[4] ?? 0, s[5] ?? 0, s[6] ?? 0, s[7] ?? 0],
        },
      };
}

/** 期待する SVG を、行から直接組み立てる (D1 の読み方と NULL の扱いを確かめる) */
function expected(
  population: readonly Row[],
  display: readonly Row[],
  extra: Partial<Pick<GrassInput, "label" | "user" | "icon" | "total" | "form" | "end">> = {},
): string {
  const all = new Map(population.map((row) => [row[0], cardDayOf(row)]));
  const slots = slotPopulation(all);
  const dayMinutes = population.map(([, w, r]) => ({ w, r }));
  // 計測開始日は母集団 (ph = '*') の最も古い日。それより前は点線の枠になる
  const startDay = population.map(([day]) => day).sort()[0];
  return renderGrass({
    today: TODAY,
    ...(startDay === undefined ? {} : { startDay }),
    days: new Map(display.map((row) => [row[0], cardDayOf(row)])),
    slotScale: buildScale(slots.map((m) => m.w + m.r)),
    slotCenter: centerOf(slots),
    dayScale: buildScale(dayMinutes.map((m) => m.w + m.r)),
    dayCenter: centerOf(dayMinutes),
    ...OPTIONS,
    ...extra,
  });
}

/** 呼ばれた引数を記録するアイコンの取得。`null` は取れなかったとき */
function iconSpy(result: string | null = ICON) {
  const calls: [string, string][] = [];
  const icon = async (project: string, user: string) => {
    calls.push([project, user]);
    return result ?? undefined;
  };
  return { icon, calls };
}

describe("GET /v1/g/demo/card.svg", () => {
  it("**200 と、カードだけ img-src data: を足した CSP**。width / height / viewBox を出す", async () => {
    const res = await SELF.fetch(DEMO_URL);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=900");
    expect(res.headers.get("content-security-policy")).toBe(CARD_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toMatch(/^<svg [^>]*width="500" height="400" viewBox="0 0 500 400"/);
  });

  it("**図を返す経路はどれも `img-src data:` を許す。説明の図は画像を読まないので許さない** (ADR-0026 決定 6)", async () => {
    for (const path of ["/v1/g/demo.svg", "/v1/g/demo/overview.svg"]) {
      const res = await SELF.fetch(`https://example.com${path}`);
      expect(res.headers.get("content-security-policy"), path).toBe(CARD_CSP);
    }
    const guide = await SELF.fetch("https://example.com/v1/guide/grass.svg");
    expect(guide.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
  });

  it("**span と cell で 4 つの形を描き分ける。外寸は GRASS_SIZES どおり** (ADR-0026)", async () => {
    for (const span of SPANS) {
      for (const cell of CELLS) {
        const svg = await (await SELF.fetch(`${DEMO_URL}?span=${span}&cell=${cell}`)).text();
        const { width, height } = GRASS_SIZES[span][cell];
        expect(svg, `${span} ${cell}`).toMatch(
          new RegExp(
            `^<svg [^>]*width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`,
          ),
        );
      }
    }
    // year は span によらず 1 年
    const past = await (await SELF.fetch(`${DEMO_URL}?year=2025&span=half`)).text();
    expect(past).toMatch(/^<svg [^>]*width="775" height="361"/);
  });

  it("ETag で 304 を返す", async () => {
    const etag = (await SELF.fetch(DEMO_URL)).headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    const again = await SELF.fetch(DEMO_URL, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
  });

  it("既定でデモの名前と固定のアイコンを描き、`l` / `u` があればそれを描く", async () => {
    const svg = await (await SELF.fetch(DEMO_URL)).text();
    expect(svg).toContain(">/cosense-grass</text>");
    expect(svg).toContain(">demo</text>");
    expect(svg).toContain(`href="${DEMO_ICON}"`);
    expect(svg).toContain('<a href="https://scrapbox.io/cosense-grass/">');

    const named = await (await SELF.fetch(`${DEMO_URL}?l=my-proj&u=taro`)).text();
    expect(named).toContain(">/my-proj</text>");
    expect(named).toContain(">taro</text>");
    expect(named).toContain('<a href="https://scrapbox.io/my-proj/">');
  });

  it("**ユーザー名はどの形でもエスケープする** (XSS を塞ぐ要点。Issue #195)", async () => {
    // 長いと草の右端で `…` に切られるので短くする
    const attack = encodeURIComponent('"><script>&');
    for (const span of SPANS) {
      for (const cell of CELLS) {
        const svg = await (
          await SELF.fetch(`${DEMO_URL}?span=${span}&cell=${cell}&u=${attack}`)
        ).text();
        expect(svg, `${span} ${cell}`).toContain(">&quot;&gt;&lt;script&gt;&amp;</text>");
        expect(svg).not.toContain("<script");
      }
    }
  });

  it("`lang=en` で英語、それ以外は日本語。`theme=dark` が効く", async () => {
    const ja = await (await SELF.fetch(DEMO_URL)).text();
    const en = await (await SELF.fetch(`${DEMO_URL}?lang=en`)).text();
    const unknown = await (await SELF.fetch(`${DEMO_URL}?lang=fr`)).text();
    const dark = await (await SELF.fetch(`${DEMO_URL}?theme=dark`)).text();

    expect(ja).toContain(">月</text>");
    expect(en).toContain(">Mon</text>");
    expect(en).not.toContain(">月</text>");
    expect(unknown).toBe(ja);
    expect(dark).not.toBe(ja);
  });

  it("**どの形にもヘルプのアイコンを描き、配布プロジェクトへリンクする** (ADR-0027)", async () => {
    for (const span of SPANS) {
      for (const cell of CELLS) {
        const svg = await (await SELF.fetch(`${DEMO_URL}?span=${span}&cell=${cell}`)).text();
        expect(svg).toMatch(
          /<g data-part="help"><a href="https:\/\/scrapbox\.io\/cosense-grass\/"><title>cosense-grass について<\/title>/,
        );
      }
    }
    const en = await (await SELF.fetch(`${DEMO_URL}?lang=en`)).text();
    expect(en).toContain("<title>About cosense-grass</title>");
  });
});

describe("renderStoredGrass", () => {
  it("**表示範囲の行と `*` の母集団から描く。区間が NULL の日は内訳なし**", async () => {
    const uid = randomUid();
    // 母集団 (`*`) は時間帯のマスが 40〜60 分。表示する行 (10〜12 分) は Level 1 になるはずで、
    // 母集団をプロジェクトの行から取ると Level が上がって食い違う
    const population: Row[] = [
      [TODAY, 105, 65, 0, 0, [5, 40, 30, 30, 5, 20, 20, 20]],
      ["2026-09-14", 105, 75, 5, 5, [5, 35, 40, 25, 5, 25, 20, 25]],
      // 内訳なし (列を足す前の日)
      ["2026-08-01", 40, 20, 0, 10, null],
      // 表示範囲 (2026-03-23 から) より古い日は母集団にだけ入る
      ["2025-09-01", 90, 90, 0, 0, [10, 30, 30, 20, 10, 30, 30, 20]],
    ];
    await store(uid, PH_ALL, population);
    const display: Row[] = [
      [TODAY, 18, 16, 1, 0, [0, 8, 6, 4, 0, 4, 6, 6]],
      ["2026-09-14", 18, 16, 0, 3, [3, 4, 5, 6, 1, 6, 5, 4]],
      ["2026-08-01", 7, 7, 0, 0, null],
    ];
    const publicId = await store(uid, PH, [...display, ["2026-03-22", 50, 50, 0, 0, null]]);

    const svg = await renderStoredGrass(env.DB, publicId, OPTIONS, NOW, iconSpy().icon);

    expect(svg).toBe(expected(population, display));
    expect(svg).toContain('fill-opacity="0.35"');
  });

  it("**アイコンは `l` と `u` がそろうときだけ取りに行き、埋め込む**", async () => {
    const publicId = await store(randomUid(), PH, [[TODAY, 4, 2, 1, 0, null]]);

    const both = iconSpy();
    const svg = await renderStoredGrass(
      env.DB,
      publicId,
      { ...OPTIONS, label: "proj", user: "taro" },
      NOW,
      both.icon,
    );
    expect(both.calls).toEqual([["proj", "taro"]]);
    expect(svg).toContain(`<image href="${ICON}"`);

    for (const names of [{ label: "proj" }, { user: "taro" }, {}]) {
      const spy = iconSpy();
      const body = await renderStoredGrass(
        env.DB,
        publicId,
        { ...OPTIONS, ...names },
        NOW,
        spy.icon,
      );
      expect(spy.calls, JSON.stringify(names)).toEqual([]);
      expect(body).not.toContain("<image");
    }

    // 取れなければ名前だけ
    const failed = iconSpy(null);
    const plain = await renderStoredGrass(
      env.DB,
      publicId,
      { ...OPTIONS, label: "proj", user: "taro" },
      NOW,
      failed.icon,
    );
    expect(plain).not.toContain("<image");
    expect(plain).toContain(">taro</text>");
  });

  it("**合算はアイコンを取りに行かず、合算の印とユーザー名を描く**", async () => {
    const rows: Row[] = [[TODAY, 4, 2, 1, 0, [0, 2, 1, 1, 0, 1, 1, 0]]];
    const publicId = await store(randomUid(), PH_ALL, rows);
    const spy = iconSpy();

    const svg = await renderStoredGrass(
      env.DB,
      publicId,
      { ...OPTIONS, label: "proj", user: "taro" },
      NOW,
      spy.icon,
    );

    expect(spy.calls).toEqual([]);
    expect(svg).toBe(expected(rows, rows, { label: "proj", user: "taro", total: true }));
    expect(svg).not.toContain("/proj");
    expect(svg).toContain(">taro</text>");
  });

  it("**year では右端の翌日まで読み、過去の 12/31 の夜に翌日の区間 0 を足す**", async () => {
    const rows: Row[] = [
      ["2025-12-30", 2, 0, 0, 0, [0, 0, 0, 2, 0, 0, 0, 0]],
      ["2025-12-31", 4, 0, 0, 0, [0, 0, 0, 4, 0, 0, 0, 0]],
      ["2026-01-01", 30, 0, 0, 0, [30, 0, 0, 0, 0, 0, 0, 0]],
    ];
    const publicId = await store(randomUid(), PH, rows);
    const options: GrassOptions = {
      ...OPTIONS,
      form: { span: "year", cell: "slot" },
      end: "2025-12-31",
    };

    const svg = await renderStoredGrass(env.DB, publicId, options, NOW, iconSpy().icon);

    expect(svg).toBe(expected([], rows, { form: options.form, end: "2025-12-31" }));
    // 翌日の行を読まなかったときの絵とは違う
    expect(svg).not.toBe(expected([], rows.slice(0, 2), { form: options.form, end: "2025-12-31" }));
  });

  it("graphs に無い publicId は undefined", async () => {
    expect(
      await renderStoredGrass(env.DB, "0".repeat(32), OPTIONS, NOW, iconSpy().icon),
    ).toBeUndefined();
  });
});

describe("GET /v1/g/{publicId}/card.svg", () => {
  it("D1 の記録から描き、ETag で 304、theme・lang・l が効く", async () => {
    const publicId = await store(randomUid(), PH, [[TODAY, 10, 5, 2, 3, null]]);
    const url = `https://example.com/v1/g/${publicId}/card.svg`;

    const res = await SELF.fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(CARD_CSP);
    const etag = res.headers.get("etag") ?? "";
    const light = await res.text();
    expect(light).toMatch(/^<svg [^>]*width="500" height="400"/);
    expect((await SELF.fetch(url, { headers: { "if-none-match": etag } })).status).toBe(304);

    const dark = await (await SELF.fetch(`${url}?theme=dark`)).text();
    const en = await (await SELF.fetch(`${url}?lang=en`)).text();
    // `u` が無いのでアイコンは取りに行かない
    const labeled = await (await SELF.fetch(`${url}?l=my-proj`)).text();
    expect(dark).not.toBe(light);
    expect(en).toContain(">Mon</text>");
    expect(labeled).toContain(">/my-proj</text>");
    expect(labeled).not.toContain("<image");
  });

  it("合算の図は `l` と `u` があってもアイコンを取りに行かずにユーザー名を描く", async () => {
    const publicId = await store(randomUid(), PH_ALL, [[TODAY, 10, 5, 2, 3, null]]);
    const svg = await (
      await SELF.fetch(`https://example.com/v1/g/${publicId}/card.svg?l=p&u=taro`)
    ).text();
    expect(svg).toContain(">taro</text>");
    expect(svg).not.toContain("<image");
  });

  it("**graphs に無い publicId と、形の違う publicId は 404**", async () => {
    for (const id of ["0".repeat(32), `${"ABCDEF".repeat(5)}AB`, "0".repeat(31)]) {
      const res = await SELF.fetch(`https://example.com/v1/g/${id}/card.svg`);
      expect(res.status, id).toBe(404);
    }
  });
});
