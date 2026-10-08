import { describe, expect, it } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { PH_ALL, phOf, publicIdOf, UID_BYTES } from "../../src/shared/ids.ts";
import {
  cardLine,
  cardUrl,
  graphIds,
  graphUrl,
  grassLine,
  grassUrl,
  WORKER_ORIGIN,
} from "../../src/userscript/worker-origin.ts";

describe("graphUrl", () => {
  it("独自ドメインの共有 SVG の URL", () => {
    expect(WORKER_ORIGIN).toBe("https://grass.soui.dev");
    expect(graphUrl("0123456789abcdef0123456789abcdef")).toBe(
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg",
    );
  });

  it("**プロジェクト名を渡すと `?l=` を付ける** (貼った先でも名前が出る。Issue #119)", () => {
    expect(graphUrl("0123456789abcdef0123456789abcdef", { project: "villagepump" })).toBe(
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg?l=villagepump",
    );
  });

  it("**ユーザー名を渡すと `u=` を付ける。プロジェクト名があれば `&` で続ける** (Issue #134)", () => {
    expect(graphUrl("0123456789abcdef0123456789abcdef", { user: "example-user" })).toBe(
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg?u=example-user",
    );
    expect(
      graphUrl("0123456789abcdef0123456789abcdef", {
        project: "villagepump",
        user: "example-user",
      }),
    ).toBe(
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg?l=villagepump&u=example-user",
    );
  });

  it("**片方だけ形が外れていれば、そちらだけ落とす**", () => {
    expect(graphUrl("0123456789abcdef0123456789abcdef", { project: "a_b", user: "ok" })).toBe(
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg?u=ok",
    );
    expect(graphUrl("0123456789abcdef0123456789abcdef", { project: "ok", user: "a\u202eb" })).toBe(
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg?l=ok",
    );
  });

  it("**漢字・空白・記号のユーザー名はエンコードして付ける** (Issue #195)", () => {
    expect(graphUrl("0123456789abcdef0123456789abcdef", { user: "山田 太郎" })).toBe(
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg?u=%E5%B1%B1%E7%94%B0%20%E5%A4%AA%E9%83%8E",
    );
    expect(graphUrl("0123456789abcdef0123456789abcdef", { user: "<x>&" })).toBe(
      "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg?u=%3Cx%3E%26",
    );
  });

  it("**形が取り決めの外なら付けない** (付けても Worker が描かないので、URL を汚さない)", () => {
    for (const name of ["-a", "a_b", "日本語", "a b", ""]) {
      expect(graphUrl("0123456789abcdef0123456789abcdef", { project: name })).toBe(
        "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg",
      );
    }
    for (const name of ["", " ", "a\nb", "a\ud800"]) {
      expect(graphUrl("0123456789abcdef0123456789abcdef", { user: name })).toBe(
        "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg",
      );
    }
  });
});

describe("cardUrl と cardLine (ADR-0024・0025)", () => {
  const ID = "0123456789abcdef0123456789abcdef";

  it("**カードの図は草と同じ publicId で、名前の付け方も草と同じ**", () => {
    expect(cardUrl(ID)).toBe(`https://grass.soui.dev/v1/g/${ID}/card.svg`);
    expect(cardUrl(ID, { project: "villagepump", user: "山田 太郎" })).toBe(
      `https://grass.soui.dev/v1/g/${ID}/card.svg?l=villagepump&u=%E5%B1%B1%E7%94%B0%20%E5%A4%AA%E9%83%8E`,
    );
    expect(cardUrl(ID, { project: "a_b", user: "a\nb" })).toBe(
      `https://grass.soui.dev/v1/g/${ID}/card.svg`,
    );
  });

  it("**カードの行はただの画像の記法で、リンク先を付けない** (ADR-0025 決定 6 の改訂)", () => {
    expect(cardLine(ID, { project: "villagepump", user: "example-user" })).toBe(
      `[https://grass.soui.dev/v1/g/${ID}/card.svg?l=villagepump&u=example-user]`,
    );
    expect(cardLine(ID, { user: "example-user" })).toBe(
      `[https://grass.soui.dev/v1/g/${ID}/card.svg?u=example-user]`,
    );
    // 取り決めの外のプロジェクト名は描かれないので URL にも載らない
    expect(cardLine(ID, { project: "a b" })).toBe(`[https://grass.soui.dev/v1/g/${ID}/card.svg]`);
  });

  it("**角括弧の中に空白・`]`・改行が入らない** (入ると Cosense の記法が切れる)", () => {
    for (const user of ["a ] b", "[x]", "山田\u3000太郎", "a\tb", "#tag", "a&b=c"]) {
      const line = cardLine(ID, { project: "p", user });
      const image = line.slice(1, -1);
      expect(image).not.toMatch(/[\s[\]]/);
      // Cosense のパーサが画像とみなす形 (`@progfay/scrapbox-parser` の ImageNode.ts)
      expect(line).toMatch(/^\[https?:\/\/[^\s\]]+\.(?:png|jpe?g|gif|svg|webp)(?:\?[^\]\s]+)?\]$/i);
    }
  });
});

describe("grassUrl と grassLine (ADR-0026)", () => {
  const id = "0123456789abcdef0123456789abcdef";
  const card = `https://grass.soui.dev/v1/g/${id}/card.svg`;
  const graph = `https://grass.soui.dev/v1/g/${id}.svg`;

  it("**選んだ形を既定に持つ経路を選び、既定と違うキーだけを付ける** (貼る行を短く保つ)", () => {
    expect(grassUrl(id, { span: "half", cell: "slot" })).toBe(card);
    expect(grassUrl(id, { span: "half", cell: "day" })).toBe(`${card}?cell=day`);
    expect(grassUrl(id, { span: "year", cell: "slot" })).toBe(`${card}?span=year`);
    // 1 年 × 1 日は `{publicId}.svg` の既定。貼ってある草と同じ URL になる
    expect(grassUrl(id, { span: "year", cell: "day" })).toBe(graph);
  });

  it("**年を選んだら 1 年で、`span` は付けず `year` だけを付ける** (Worker も year があれば 1 年で描く)", () => {
    expect(grassUrl(id, { span: "half", cell: "slot", year: 2026 })).toBe(`${card}?year=2026`);
    expect(grassUrl(id, { span: "half", cell: "day", year: 2026 })).toBe(`${graph}?year=2026`);
  });

  it("**名前は形の後に `l=` / `u=` で続け、形が外れていれば付けない**", () => {
    expect(grassUrl(id, { span: "half", cell: "day" }, { project: "p", user: "山田" })).toBe(
      `${card}?cell=day&l=p&u=${encodeURIComponent("山田")}`,
    );
    expect(grassUrl(id, { span: "year", cell: "day" }, { project: "../x" })).toBe(graph);
  });

  it("**`i=` (Gyazo の画像 ID) は project・user・icon がそろい、形が正しいときだけ末尾に付く** (ADR-0028)", () => {
    const icon = "fedcba9876543210fedcba9876543210";
    const names = { project: "p", user: "u", icon };
    expect(grassUrl(id, { span: "half", cell: "day" }, names)).toBe(
      `${card}?cell=day&l=p&u=u&i=${icon}`,
    );
    expect(cardLine(id, names)).toBe(`[${card}?l=p&u=u&i=${icon}]`);

    // project か user が無ければ、Worker はアイコンを描かないので付けない
    expect(grassUrl(id, { span: "half", cell: "slot" }, { project: "p", icon })).toBe(
      `${card}?l=p`,
    );
    expect(grassUrl(id, { span: "half", cell: "slot" }, { user: "u", icon })).toBe(`${card}?u=u`);
    // project が形の外れで付かないときも付けない
    expect(grassUrl(id, { span: "half", cell: "slot" }, { project: "../x", user: "u", icon })).toBe(
      `${card}?u=u`,
    );
    // ID の形が外れていれば付けない
    for (const bad of ["x", icon.toUpperCase(), `${icon}0`, "../x", ""]) {
      expect(grassUrl(id, { span: "half", cell: "slot" }, { ...names, icon: bad }), bad).toBe(
        `${card}?l=p&u=u`,
      );
    }
  });

  it("**貼る行はただの画像の記法で、空白と `]` を含まない**", () => {
    const line = grassLine(id, { span: "year", cell: "slot", year: 2026 }, { user: "a b]" });
    expect(line).toBe(`[${card}?year=2026&u=a%20b%5D]`);
    expect(line.slice(1, -1)).not.toMatch(/[\s\]]/);
  });

  it("**プロフィールに貼る行 (`cardLine`) は形のクエリを付けない** (ダイアログで選んだ形を混ぜない)", () => {
    expect(cardLine(id, { project: "p" })).toBe(`[${card}?l=p]`);
    expect(graphUrl(id)).toBe(graph);
  });
});

describe("graphIds", () => {
  const UID = encodeBase64url(new Uint8Array(UID_BYTES).fill(7));

  it("**プロジェクトなら phOf → publicIdOf、省けば合算 (`*`)** (導き方を 1 か所に。ADR-0025)", async () => {
    const ph = await phOf(UID, "my-project");
    expect(await graphIds(UID, "my-project")).toEqual({
      ph,
      publicId: await publicIdOf(UID, ph),
    });
    expect(await graphIds(UID)).toEqual({ ph: PH_ALL, publicId: await publicIdOf(UID, PH_ALL) });
  });
});
