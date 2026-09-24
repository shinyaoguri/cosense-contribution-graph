import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AUTH_START_PATH } from "../../src/shared/auth.ts";
import { DEMO_PUBLIC_ID } from "../../src/worker/svg.ts";

const ORIGIN = "https://example.com";

async function fetchPage(path: string): Promise<{ res: Response; html: string }> {
  const res = await SELF.fetch(`${ORIGIN}${path}`);
  return { res, html: await res.text() };
}

describe("トップ /", () => {
  it("**導入の 1 行とデモの草を出す**", async () => {
    const { res, html } = await fetchPage("/");

    expect(res.status).toBe(200);
    expect(html).toContain('import "/api/code/cosense-grass/v1/script.js"');
    expect(html).toContain(`/v1/g/${DEMO_PUBLIC_ID}.svg`);
    expect(html).toContain("/account");
    expect(html).toContain("/privacy");
  });

  it("**OAuth の同意画面の審査が見るものを満たす** — 公式サービスと紛らわしくなく、ポリシーへリンクする", async () => {
    const { html } = await fetchPage("/");

    // アプリ名 (同意画面の App name と同じ) と、Cosense の公式ではないこと (Issue #141、research §6)
    expect(html).toContain("<h1>cosense-grass</h1>");
    expect(html).toContain("Cosense の公式サービスではありません");
    // 同意画面に登録するポリシーの URL と同じパス
    expect(html).toContain('href="/privacy"');
  });

  it("**Google のデータを使う目的を、ログインなしで読める形で説明する** (brand verification の差し戻し、Issue #141)", async () => {
    const { html } = await fetchPage("/");

    expect(html).toContain("<h2>Google サインインを使う理由</h2>");
    // 自動判定が読めるよう英語でも、アプリ名と目的と Google のデータの用途を書く
    expect(html).toContain('<h2 lang="en">About cosense-grass</h2>');
    expect(html).toContain("<strong>cosense-grass</strong> visualizes your activity on Cosense");
    expect(html).toContain("Google Sign-In is used only to merge records from your devices");
    // 最初の本文は英語の説明 (h1 の直後)
    expect(html).toContain('<h1>cosense-grass</h1>\n<h2 lang="en">About cosense-grass</h2>');
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
    expect(html).toContain('<a href="/account">管理のページ</a>で自分の草を見られます');
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

describe("プライバシーポリシー /privacy", () => {
  it("**docs/privacy.md を HTML にして出す** (文面を 2 か所に置かない)", async () => {
    const { res, html } = await fetchPage("/privacy");

    expect(res.status).toBe(200);
    expect(html).toContain("<h1>cosense-grass プライバシーポリシー</h1>");
    // 正本にある節と表が出る
    expect(html).toContain("<h2>保存しないもの</h2>");
    expect(html).toContain("<table>");
    expect(html).toContain("<code>__Host-grass-auth</code>");
    // 草案の但し書きは消えている (配信するので)
    expect(html).not.toContain("草案");
  });

  it("**Google から受け取る情報の扱いを開示する** (OAuth の同意画面の審査の要件、Issue #141)", async () => {
    const { html } = await fetchPage("/privacy");

    expect(html).toContain(
      '<a href="https://developers.google.com/terms/api-services-user-data-policy"',
    );
    expect(html).toContain("Limited Use");
    // 取得・利用・共有・保護・保持と削除を 1 か所で述べる。英語の要約も付ける
    expect(html).toContain("<h2>Google ユーザーデータの取り扱い</h2>");
    for (const item of ["取得するもの:", "使い方:", "共有:", "保護:", "保持と削除:"]) {
      expect(html).toContain(item);
    }
    expect(html).toContain("<h2>Summary in English</h2>");
    expect(html).toContain("Cosense の公式サービスではありません");
  });

  it("正本のリンクは a になる", async () => {
    const { html } = await fetchPage("/privacy");

    expect(html).toContain('<a href="https://github.com/shinyaoguri/cosense-contribution-graph"');
  });
});

describe("それ以外", () => {
  it("知らないパスは 404 のまま", async () => {
    const { res } = await fetchPage("/nope");

    expect(res.status).toBe(404);
  });
});
