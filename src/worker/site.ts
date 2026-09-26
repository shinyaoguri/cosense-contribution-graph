/**
 * 人が読むページ — `/` (トップ) と `/privacy` (プライバシーポリシー)。ADR-0018、Issue #88。
 *
 * - **ポリシーは `docs/privacy.md` を正本のまま配信する。** Text モジュールとして読み込み、
 *   `markdown.ts` で HTML にする (wrangler.jsonc の `rules`)。**2 か所に同じ文面を置かない**
 * - トップはデモの草を `<img>` で出す。導入の 1 行と、サインインの導線、管理・ポリシーへのリンクを置く
 * - `account.ts`・`auth-page.ts` と同じ作法 — スタイルは固定の文字列で CSP はハッシュ、
 *   **スクリプトは 1 行も載せない**、`referrer-policy: no-referrer`
 * - **キャッシュする。** 中身はデプロイでしか変わらないので、ページは 1 時間 (`account.ts` の `no-store` と対照的)
 */
import privacyMarkdown from "../../docs/privacy.md";
import { ACCOUNT_PATH } from "../shared/auth.ts";
import { FAVICON_LINK } from "./favicon.ts";
import { renderMarkdown } from "./markdown.ts";
import { DEMO_PUBLIC_ID } from "./svg.ts";

export const HOME_PATH = "/";
export const PRIVACY_PATH = "/privacy";

/** 配布ページ (ADR-0005)。トップから導入の手順を案内する。 */
const DISTRIBUTION_URL = "https://scrapbox.io/cosense-grass/";

const REPOSITORY_URL = "https://github.com/shinyaoguri/cosense-contribution-graph";

const CACHE_CONTROL = "public, max-age=3600";

const STYLE = `body { font-family: system-ui, sans-serif; margin: 2rem auto; padding: 0 1rem; max-width: 46rem; line-height: 1.7; color: #1f2328; background: #fff; }
@media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } }
h1 { font-size: 1.6rem; }
h2 { font-size: 1.2rem; margin-top: 2rem; }
table { border-collapse: collapse; margin: 1rem 0; }
th, td { padding: 0.4rem 0.8rem; border-bottom: 1px solid #8b949e; text-align: left; vertical-align: top; }
code { padding: 0.1rem 0.3rem; background: #8b949e33; border-radius: 4px; word-break: break-all; }
pre { padding: 0.8rem; background: #8b949e22; border-radius: 6px; overflow-x: auto; }
pre code { padding: 0; background: none; }
img { max-width: 100%; }
small { color: #8b949e; }`;

/** 計算済みの CSP。**Promise ではなく文字列で持つ** (`auth-page.ts` と同じ理由) */
let cachedCsp: string | undefined;

async function siteCsp(): Promise<string> {
  if (cachedCsp === undefined) {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(STYLE)),
    );
    const style = `sha256-${btoa(String.fromCharCode(...digest))}`;
    // 草の SVG は同じオリジンから出す
    cachedCsp = `default-src 'none'; script-src 'none'; style-src '${style}'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  }
  return cachedCsp;
}

export function handleHome(): Promise<Response> {
  const body = `<h1>cosense-grass</h1>
<h2 lang="en">About cosense-grass</h2>
<div lang="en">
<p><strong>cosense-grass</strong> visualizes your activity on Cosense (formerly Scrapbox) as a one-year contribution graph ("grass").
A user script counts the minutes you spend writing and reading in each Cosense project, and this service draws the graph as an image
that you can embed or share.</p>
<p>Google Sign-In is used only to merge records from your devices into one graph. We request the <code>openid</code> scope only and
never receive your email address or name. Signing in is not required to read this page or to view a shared graph.
See the <a href="${PRIVACY_PATH}">privacy policy</a> for details.</p>
<p>cosense-grass is a personal project and is not affiliated with Cosense or Helpfeel Inc.</p>
</div>

<h2>cosense-grass について</h2>
<p>Cosense (旧 Scrapbox) での活動を、1 年分の「草」として見えるようにするツールです。
書いた時間と読んだ時間を分単位で数え、日ごとの量を色の濃さ、読み書きの比を色合いで表します。</p>
<p><small>Cosense の公式サービスではありません。運営元の株式会社 Helpfeel とは関係のない、個人のプロジェクトです。</small></p>

<img src="/v1/g/${DEMO_PUBLIC_ID}.svg" width="775" height="200" alt="草の例 (デモ)">
<p>書いた時間は、新しく作ったページ (作る)・自分が前に作ったページ (育てる)・他の人のページ (関わる) に分けて数え、
読んだ時間 (読む) と並べた割合を「活動の概観」として出します。</p>
<img src="/v1/g/${DEMO_PUBLIC_ID}/overview.svg" width="300" height="220" alt="活動の概観の例 (デモ)">
<p><small>デモの草と活動の概観です。実際の記録ではありません。</small></p>

<h2>Google サインインを使う理由</h2>
<p>記録は Cosense を開いた端末 (PC やブラウザ) ごとに数えます。
<strong>Google でサインインすると、複数の端末の記録を同じ 1 人の草にまとめられます。</strong>
サインインは端末を追加するときだけで、このページや草を見るのにサインインは要りません。
受け取るのは Google アカウントの識別子だけで、メールアドレスや氏名は受け取りません
(<a href="${PRIVACY_PATH}">プライバシーポリシー</a>)。</p>

<h2>使い方</h2>
<p>Cosense の自分のユーザーページ (<code>/{project}/{username}</code>) の <code>script.js</code> に、
配布ページの 1 行を書き足します。バンドルは
<a href="${DISTRIBUTION_URL}">公開プロジェクト /cosense-grass</a> にあります。</p>
<pre><code>import "/api/code/cosense-grass/v1/script.js"</code></pre>
<p>入れると、そのプロジェクトでの活動を数え始めます。<strong>入れる前の活動は数えません。</strong>
複数のプロジェクトで使うときは、それぞれのユーザーページに同じ 1 行を書きます。</p>
<p>ページメニューに「cosense-grass」が増えます。
草をほかの端末とまとめたり、共有 URL を作ったりするには、そのダイアログの「設定」から Google でサインインします。</p>
<p>すでに Cosense で設定を済ませている方は、<a href="${ACCOUNT_PATH}">管理のページ</a>で自分の草を見られます。</p>

<h2>保存されるもの</h2>
<p>サーバに送るのは<strong>「何日の何分に活動したか」だけ</strong>です。
ページの題名も中身もプロジェクト名も送りません。くわしくは
<a href="${PRIVACY_PATH}">プライバシーポリシー</a>をご覧ください。</p>

<h2>リンク</h2>
<ul>
<li><a href="${ACCOUNT_PATH}">管理のページ</a> — 登録した端末の一覧と失効、共有 URL、データの削除</li>
<li><a href="${PRIVACY_PATH}">プライバシーポリシー</a></li>
<li><a href="${REPOSITORY_URL}">GitHub</a> — ソースコードと設計</li>
</ul>`;
  // **title はアプリ名だけにする** (OAuth の同意画面の App name と同じ文字列。brand verification の自動判定が見る、Issue #141)
  return page("cosense-grass", body, HOME_HEAD);
}

export function handlePrivacy(): Promise<Response> {
  return page("cosense-grass のプライバシーポリシー", renderMarkdown(privacyMarkdown));
}

/** トップだけの `<head>`。アプリ名と目的を機械が読める形でも出す (Issue #141) */
const HOME_HEAD = `<meta name="application-name" content="cosense-grass">
<meta name="description" content="cosense-grass visualizes your activity on Cosense (formerly Scrapbox) as a one-year contribution graph.">`;

async function page(title: string, body: string, head = ""): Promise<Response> {
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
${FAVICON_LINK}
<title>${title}</title>
${head ? `${head}\n` : ""}<style>${STYLE}</style>
</head>
<body>
${body}
<hr>
<p><small><a href="${HOME_PATH}">cosense-grass</a> ・
<a href="${ACCOUNT_PATH}">管理</a> ・
<a href="${PRIVACY_PATH}">プライバシー</a> ・
<a href="${REPOSITORY_URL}">GitHub</a></small></p>
</body>
</html>
`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": await siteCsp(),
      "cache-control": CACHE_CONTROL,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
