/**
 * 人が読むページ — トップとプライバシーポリシー。ADR-0018・0022、Issue #88。
 *
 * - **英語を既定にし、日本語を `/ja` の下に分ける** (ADR-0022)。`/` と `/privacy` は Google の同意画面に
 *   登録した URL で、審査が読むので英語にする。日本語は `/ja` と `/ja/privacy`。上端のリンクで行き来する
 * - **ポリシーは `docs/privacy.en.md` (英語) と `docs/privacy.md` (日本語) を正本のまま配信する。** Text モジュールとして読み込み、
 *   `markdown.ts` で HTML にする (wrangler.jsonc の `rules`)。**2 つは全訳どうしで、節と表の行の数をテストで突き合わせる**
 * - トップはデモの草を `<img>` で出す。導入の 1 行と、管理・ポリシーへのリンクを置く (サインインへ直接はつながない、Issue #141)
 * - `account.ts`・`auth-page.ts` と同じ作法 — スタイルは固定の文字列で CSP はハッシュ、
 *   **スクリプトは 1 行も載せない**、`referrer-policy: no-referrer`
 * - **キャッシュする。** 中身はデプロイでしか変わらないので、ページは 1 時間 (`account.ts` の `no-store` と対照的)
 */
import privacyEnMarkdown from "../../docs/privacy.en.md";
import privacyMarkdown from "../../docs/privacy.md";
import { ACCOUNT_PATH } from "../shared/auth.ts";
import {
  DISTRIBUTION_URL,
  PRIVACY_JA_PATH,
  PRIVACY_PATH,
  REPOSITORY_URL,
} from "../shared/links.ts";
import { FAVICON_LINK } from "./favicon.ts";
import { renderMarkdown } from "./markdown.ts";
import { DEMO_PUBLIC_ID } from "./svg.ts";

export const HOME_PATH = "/";

/** 日本語のトップ (ADR-0022) */
export const HOME_JA_PATH = "/ja";

type Lang = "en" | "ja";

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
small { color: #8b949e; }
nav.lang { display: flex; justify-content: flex-end; gap: 0.5rem; font-size: 0.9rem; }
nav.lang a, nav.lang span { padding: 0.2rem 0.7rem; border: 1px solid #8b949e; border-radius: 999px; text-decoration: none; }
nav.lang span { background: #8b949e33; }`;

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

/** トップ (英語)。**Google の同意画面に登録した URL** なので英語を既定にする (ADR-0022) */
export function handleHome(lang: Lang): Promise<Response> {
  // **title はアプリ名だけにする** (OAuth の同意画面の App name と同じ文字列。brand verification の自動判定が見る、Issue #141)
  return page(lang, "home", "cosense-grass", lang === "en" ? HOME_EN : HOME_JA, HOME_HEAD);
}

export function handlePrivacy(lang: Lang): Promise<Response> {
  return lang === "en"
    ? page(lang, "privacy", "cosense-grass Privacy Policy", renderMarkdown(privacyEnMarkdown))
    : page(
        lang,
        "privacy",
        "cosense-grass のプライバシーポリシー",
        renderMarkdown(privacyMarkdown),
      );
}

/**
 * 英語のトップ。**最初の本文 (h1 の直後) はアプリの目的と Google のデータの用途**にする (Issue #141)。
 * 日本語のトップ (`HOME_JA`) と同じ節を同じ順に並べる
 */
const HOME_EN = `<h1>cosense-grass</h1>
<p><strong>cosense-grass</strong> visualizes your activity on Cosense (formerly Scrapbox) as a one-year contribution graph ("grass").
A user script counts the minutes you spend writing and reading in each Cosense project, and this service draws the graph as an image
that you can embed or share. The amount of activity per day is shown by the depth of color, and the balance of writing and reading by the hue.</p>
<p><small>cosense-grass is not an official Cosense service. It is a personal project and is not affiliated with Helpfeel Inc., the operator of Cosense.</small></p>

<img src="/v1/g/${DEMO_PUBLIC_ID}.svg" width="775" height="200" alt="Example graph (demo)">
<p>Minutes written are split into pages you newly created (Create), pages you created before (Grow), and pages created by others (Engage),
and shown as an "activity overview" together with minutes read (Read).</p>
<img src="/v1/g/${DEMO_PUBLIC_ID}/overview.svg" width="300" height="220" alt="Example activity overview (demo)">
<p><small>The graph and activity overview above are demos, not real records.</small></p>

<h2>Why we use Google Sign-In</h2>
<p>Activity is counted separately on each device (computer or browser) where you open Cosense.
<strong>Google Sign-In is used only to merge records from your devices into one graph.</strong>
You sign in only when adding a device; signing in is not required to read this page or to view a shared graph.
We request the <code>openid</code> scope only and receive only your Google account identifier. We never receive your email address or name
(<a href="${PRIVACY_PATH}">privacy policy</a>).</p>

<h2>How to use</h2>
<p>Add one line from the distribution page to <code>script.js</code> on your own user page in Cosense (<code>/{project}/{username}</code>).
The bundle is in the <a href="${DISTRIBUTION_URL}">public project /cosense-grass</a>.</p>
<pre><code>import "/api/code/cosense-grass/v1/script.js"</code></pre>
<p>Once added, it starts counting your activity in that project. <strong>Activity before you add it is not counted.</strong>
To use it in multiple projects, add the same line to your user page in each project.</p>
<p>"cosense-grass" is added to the page menu.
To merge your graph with other devices or to create a share URL, sign in with Google from "設定" (Settings) in that dialog.</p>
<p>If you have already set it up in Cosense, you can see your graph on the <a href="${ACCOUNT_PATH}">management page</a>.</p>

<h2>What is stored</h2>
<p>The only thing sent to the server is <strong>which minutes of which days you were active</strong>.
Page titles, page contents, and project names are never sent. See the
<a href="${PRIVACY_PATH}">privacy policy</a> for details.</p>

<h2>Links</h2>
<ul>
<li><a href="${ACCOUNT_PATH}">Management page</a> — list and revoke registered devices, share URLs, delete your data</li>
<li><a href="${PRIVACY_PATH}">Privacy policy</a></li>
<li><a href="${REPOSITORY_URL}">GitHub</a> — source code and design</li>
</ul>`;

/** 日本語のトップ。英語版 (`HOME_EN`) と同じ節を同じ順に並べる */
const HOME_JA = `<h1>cosense-grass</h1>
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
(<a href="${PRIVACY_JA_PATH}">プライバシーポリシー</a>)。</p>

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
<a href="${PRIVACY_JA_PATH}">プライバシーポリシー</a>をご覧ください。</p>

<h2>リンク</h2>
<ul>
<li><a href="${ACCOUNT_PATH}">管理のページ</a> — 登録した端末の一覧と失効、共有 URL、データの削除</li>
<li><a href="${PRIVACY_JA_PATH}">プライバシーポリシー</a></li>
<li><a href="${REPOSITORY_URL}">GitHub</a> — ソースコードと設計</li>
</ul>`;

/** トップだけの `<head>`。アプリ名と目的を機械が読める形でも出す (Issue #141) */
const HOME_HEAD = `<meta name="application-name" content="cosense-grass">
<meta name="description" content="cosense-grass visualizes your activity on Cosense (formerly Scrapbox) as a one-year contribution graph.">`;

/** 言語ごとのパスとフッターの文言。**英語と日本語で同じ種類のページを対にする** (ADR-0022) */
const LOCALES = {
  en: {
    paths: { home: HOME_PATH, privacy: PRIVACY_PATH },
    name: "English",
    footer: { account: "Management", privacy: "Privacy" },
  },
  ja: {
    paths: { home: HOME_JA_PATH, privacy: PRIVACY_JA_PATH },
    name: "日本語",
    footer: { account: "管理", privacy: "プライバシー" },
  },
} as const;

const LANGS = ["en", "ja"] as const satisfies readonly Lang[];

type PageKind = keyof (typeof LOCALES)["en"]["paths"];

/**
 * 言語の切り替え。**スクリプトを載せないので、ボタンではなく対のページへのリンク**にする。
 * いまの言語はリンクにせず、`aria-current` で示す
 */
function languageSwitch(lang: Lang, kind: PageKind): string {
  const items = LANGS.map((other) =>
    other === lang
      ? `<span aria-current="page">${LOCALES[other].name}</span>`
      : `<a href="${LOCALES[other].paths[kind]}" hreflang="${other}" lang="${other}">${LOCALES[other].name}</a>`,
  );
  return `<nav class="lang" aria-label="Language">${items.join("\n")}</nav>`;
}

/** 検索エンジンと審査の自動判定に、対のページがあることを伝える */
function alternates(kind: PageKind): string {
  return LANGS.map(
    (other) => `<link rel="alternate" hreflang="${other}" href="${LOCALES[other].paths[kind]}">`,
  ).join("\n");
}

async function page(
  lang: Lang,
  kind: PageKind,
  title: string,
  body: string,
  head = "",
): Promise<Response> {
  const { paths, footer } = LOCALES[lang];
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
${FAVICON_LINK}
<title>${title}</title>
${alternates(kind)}
${head ? `${head}\n` : ""}<style>${STYLE}</style>
</head>
<body>
${languageSwitch(lang, kind)}
${body}
<hr>
<p><small><a href="${paths.home}">cosense-grass</a> ·
<a href="${ACCOUNT_PATH}">${footer.account}</a> ·
<a href="${paths.privacy}">${footer.privacy}</a> ·
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
