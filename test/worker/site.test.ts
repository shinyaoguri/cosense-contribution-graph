import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AUTH_START_PATH } from "../../src/shared/auth.ts";
import { DEMO_PUBLIC_ID } from "../../src/worker/svg.ts";

const ORIGIN = "https://example.com";

async function fetchPage(path: string): Promise<{ res: Response; html: string }> {
  const res = await SELF.fetch(`${ORIGIN}${path}`);
  return { res, html: await res.text() };
}

describe("トップ / (英語)", () => {
  it("**導入の 1 行とデモの草を出す**", async () => {
    const { res, html } = await fetchPage("/");

    expect(res.status).toBe(200);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('import "/api/code/cosense-grass/v1/script.js"');
    expect(html).toContain(`/v1/g/${DEMO_PUBLIC_ID}.svg`);
    // 活動の概観のデモも草の下に並べる (ADR-0021)
    expect(html).toContain(
      `<img src="/v1/g/${DEMO_PUBLIC_ID}/overview.svg" width="300" height="220"`,
    );
    expect(html).toContain('href="/account"');
    // 英語のページからは英語のポリシーへ
    expect(html).toContain('href="/privacy"');
    expect(html).not.toContain('href="/ja/privacy"');
  });

  it("**本文を日本語で書かない** — 審査が読む URL なので英語だけにする (ADR-0022)", async () => {
    const { html } = await fetchPage("/");

    // 日本語は切り替えのリンクの「日本語」と、UserScript の UI の名前 (「設定」) だけ
    const japanese = html.match(/[\u3040-\u30ff\u4e00-\u9fff]+/g) ?? [];
    expect(new Set(japanese)).toEqual(new Set(["日本語", "設定"]));
  });

  it("**OAuth の同意画面の審査が見るものを満たす** — 公式サービスと紛らわしくなく、ポリシーへリンクする", async () => {
    const { html } = await fetchPage("/");

    // アプリ名 (同意画面の App name と同じ) と、Cosense の公式ではないこと (Issue #141、research §6)
    expect(html).toContain("<h1>cosense-grass</h1>");
    expect(html).toContain("cosense-grass is not an official Cosense service");
    // 同意画面に登録するポリシーの URL と同じパス
    expect(html).toContain('href="/privacy"');
  });

  it("**Google のデータを使う目的を、ログインなしで読める形で説明する** (brand verification の差し戻し、Issue #141)", async () => {
    const { html } = await fetchPage("/");

    expect(html).toContain("<h2>Why we use Google Sign-In</h2>");
    expect(html).toContain("Google Sign-In is used only to merge records from your devices");
    // 最初の本文はアプリの目的 (h1 の直後)
    expect(html).toContain(
      "<h1>cosense-grass</h1>\n<p><strong>cosense-grass</strong> visualizes your activity on Cosense",
    );
  });

  it("**title と meta もアプリ名にする** (同意画面の App name と同じ文字列)", async () => {
    const { html } = await fetchPage("/");

    expect(html).toContain("<title>cosense-grass</title>");
    expect(html).toContain('<meta name="application-name" content="cosense-grass">');
    expect(html).toContain('<meta name="description" content="cosense-grass visualizes');
  });

  it("**サインインへ直接つながるリンクを置かず、管理のページへ案内する** (ログインページに見せない、Issue #141)", async () => {
    const { html } = await fetchPage("/");

    expect(html).not.toContain(AUTH_START_PATH);
    expect(html).toContain('<a href="/account">management page</a>');
  });

  it("**スクリプトを載せず、CSP で止める**", async () => {
    const { res, html } = await fetchPage("/");

    expect(html).not.toContain("<script");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'none'");
    // 草の SVG は同じオリジンから
    expect(csp).toContain("img-src 'self'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("**中身はデプロイでしか変わらないのでキャッシュする**", async () => {
    const { res } = await fetchPage("/");

    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });
});

describe("トップ /ja (日本語)", () => {
  it("**日本語の本文を出し、日本語のポリシーへつなぐ**", async () => {
    const { res, html } = await fetchPage("/ja");

    expect(res.status).toBe(200);
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain("<title>cosense-grass</title>");
    expect(html).toContain("<h1>cosense-grass</h1>\n<p>Cosense (旧 Scrapbox) での活動を");
    expect(html).toContain("Cosense の公式サービスではありません");
    expect(html).toContain("<h2>Google サインインを使う理由</h2>");
    expect(html).toContain('import "/api/code/cosense-grass/v1/script.js"');
    expect(html).toContain(`/v1/g/${DEMO_PUBLIC_ID}.svg`);
    expect(html).toContain('<a href="/account">管理のページ</a>で自分の草を見られます');
    expect(html).toContain('href="/ja/privacy"');
    expect(html).not.toContain('href="/privacy"');
    expect(html).not.toContain(AUTH_START_PATH);
  });

  it("**英語の節を混ぜない** (英語は / に分けた、ADR-0022)", async () => {
    const { html } = await fetchPage("/ja");

    expect(html).not.toContain("About cosense-grass");
    expect(html).not.toContain("Google Sign-In is used");
  });
});

describe("言語の切り替え", () => {
  const PAIRS = [
    { en: "/", ja: "/ja" },
    { en: "/privacy", ja: "/ja/privacy" },
  ];

  for (const { en, ja } of PAIRS) {
    it(`**${en} と ${ja} が互いにリンクし、hreflang で対を示す**`, async () => {
      const english = (await fetchPage(en)).html;
      const japanese = (await fetchPage(ja)).html;

      // スクリプトを載せないので、切り替えは対のページへのリンク
      expect(english).toContain(`<a href="${ja}" hreflang="ja" lang="ja">日本語</a>`);
      expect(english).toContain('<span aria-current="page">English</span>');
      expect(japanese).toContain(`<a href="${en}" hreflang="en" lang="en">English</a>`);
      expect(japanese).toContain('<span aria-current="page">日本語</span>');
      for (const html of [english, japanese]) {
        expect(html).toContain(`<link rel="alternate" hreflang="en" href="${en}">`);
        expect(html).toContain(`<link rel="alternate" hreflang="ja" href="${ja}">`);
      }
    });
  }
});

describe("プライバシーポリシー /privacy (英語) と /ja/privacy (日本語)", () => {
  it("**docs/privacy.en.md を HTML にして /privacy で出す** (Google の同意画面に登録した URL)", async () => {
    const { res, html } = await fetchPage("/privacy");

    expect(res.status).toBe(200);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<h1>cosense-grass Privacy Policy</h1>");
    expect(html).toContain("<h2>What we do not store</h2>");
    expect(html).toContain("<table>");
    expect(html).toContain("<code>__Host-grass-auth</code>");
    expect(html).toContain("It is not an official Cosense service.");
  });

  it("**Google から受け取る情報の扱いを英語で開示する** (OAuth の同意画面の審査の要件、Issue #141)", async () => {
    const { html } = await fetchPage("/privacy");

    expect(html).toContain(
      '<a href="https://developers.google.com/terms/api-services-user-data-policy"',
    );
    expect(html).toContain("Limited Use");
    // 取得・利用・共有・保護・保持と削除を 1 か所で述べる
    expect(html).toContain("<h2>How we handle Google user data</h2>");
    for (const item of [
      "What we access:",
      "How we use it:",
      "Sharing:",
      "Protection:",
      "Retention and deletion:",
    ]) {
      expect(html).toContain(item);
    }
  });

  it("**docs/privacy.md を HTML にして /ja/privacy で出す** (文面を 2 か所に置かない)", async () => {
    const { res, html } = await fetchPage("/ja/privacy");

    expect(res.status).toBe(200);
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain("<h1>cosense-grass プライバシーポリシー</h1>");
    expect(html).toContain("<h2>保存しないもの</h2>");
    expect(html).toContain("<h2>Google ユーザーデータの取り扱い</h2>");
    for (const item of ["取得するもの:", "使い方:", "共有:", "保護:", "保持と削除:"]) {
      expect(html).toContain(item);
    }
    expect(html).toContain("Limited Use");
    // 英語の要約は /privacy に分けたので載せない
    expect(html).not.toContain("Summary in English");
    // 草案の但し書きは消えている (配信するので)
    expect(html).not.toContain("草案");
  });

  it("**英語版と日本語版は全訳どうし** — 節・表の行・箇条書きの数が一致する", async () => {
    const count = (html: string, tag: string) => html.split(`<${tag}>`).length - 1;
    const english = (await fetchPage("/privacy")).html;
    const japanese = (await fetchPage("/ja/privacy")).html;

    for (const tag of ["h2", "tr", "li", "table"]) {
      expect(count(english, tag), tag).toBe(count(japanese, tag));
    }
  });

  it("正本のリンクは a になる", async () => {
    for (const path of ["/privacy", "/ja/privacy"]) {
      const { html } = await fetchPage(path);

      expect(html).toContain('<a href="https://github.com/shinyaoguri/cosense-contribution-graph"');
    }
  });
});

describe("それ以外", () => {
  it("知らないパスは 404 のまま", async () => {
    for (const path of ["/nope", "/ja/", "/ja/nope", "/en"]) {
      const { res } = await fetchPage(path);

      expect(res.status, path).toBe(404);
    }
  });
});
