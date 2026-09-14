/**
 * `/auth/callback` がポップアップに返す HTML (design §3・§6)。
 *
 * - **値をスクリプトに埋め込まない。** スクリプトとスタイルは固定の文字列で、コードは `data-code` 属性から読む。
 *   CSP をハッシュで書け、値によって CSP が変わらない
 * - `window.opener` があれば `postMessage` で `https://scrapbox.io` だけに送る。**同じコードを画面にも出す**
 *   (COOP で opener が切れたときに利用者が貼る)
 * - **COOP を付けない。** `same-origin` を付けると opener が切れて postMessage が壊れる (research §6)
 * - Google が返す `error_description` は受け取らない。文言は理由の種類から選ぶ固定文だけ
 */
import { AUTH_MESSAGE_TYPE, AUTH_OPENER_ORIGIN } from "../shared/auth.ts";

export type AuthFailure = "cancelled" | "expired" | "failed";

export type AuthPage =
  | { readonly kind: "issued"; readonly code: string }
  | { readonly kind: "failed"; readonly failure: AuthFailure };

const FAILURE_TEXT: Record<AuthFailure, string> = {
  cancelled: "サインインを取り消しました。このウィンドウを閉じてください。",
  expired:
    "サインインの有効期限が切れたか、別のサインインと混ざりました。Cosense からもう一度やり直してください。",
  failed: "サインインに失敗しました。時間をおいて、Cosense からもう一度やり直してください。",
};

/**
 * 親に結果を送り、アドレスバーと履歴から code と state を消す。
 * **送り先は `AUTH_OPENER_ORIGIN` 固定。`"*"` にしない** (コードを他のオリジンへ渡さない)。
 */
export const AUTH_PAGE_SCRIPT = `(() => {
  const result = document.getElementById("result");
  const message = result.dataset.code
    ? { type: ${JSON.stringify(AUTH_MESSAGE_TYPE)}, v: 1, code: result.dataset.code }
    : { type: ${JSON.stringify(AUTH_MESSAGE_TYPE)}, v: 1, error: result.dataset.error };
  history.replaceState(null, "", location.pathname);
  if (window.opener) {
    window.opener.postMessage(message, ${JSON.stringify(AUTH_OPENER_ORIGIN)});
  }
})();`;

export const AUTH_PAGE_STYLE = `body { font-family: system-ui, sans-serif; margin: 2rem 1rem; line-height: 1.6; color: #1f2328; background: #fff; }
@media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } }
code { display: block; margin: 1rem 0; padding: 0.75rem; font-size: 1.1rem; word-break: break-all; user-select: all; border: 1px solid #8b949e; border-radius: 6px; }
small { color: #8b949e; }`;

/** 計算済みの CSP。**Promise ではなく文字列で持つ** (workerd では別のリクエストで作った Promise を待たない) */
let cachedCsp: string | undefined;

/** スクリプトとスタイルの SHA-256 を CSP に載せる。**ハッシュは標準の base64 (パディングあり)** */
async function authPageCsp(): Promise<string> {
  if (cachedCsp === undefined) {
    const [script, style] = await Promise.all([
      cspHash(AUTH_PAGE_SCRIPT),
      cspHash(AUTH_PAGE_STYLE),
    ]);
    cachedCsp = `default-src 'none'; script-src '${script}'; style-src '${style}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  }
  return cachedCsp;
}

export async function authPageResponse(
  page: AuthPage,
  status: 200 | 400 | 403 | 500 | 502,
): Promise<Response> {
  const body =
    page.kind === "issued"
      ? `<p>サインインしました。Cosense に戻ります。</p>
<p>Cosense で「コードを貼ってください」と表示されたら、次のコードを貼ってください。</p>
<code id="result" data-code="${escapeHtml(page.code)}">${escapeHtml(page.code)}</code>
<p><small>このコードは Cosense の草の設定にだけ貼ってください。他のサイトや人には渡さないでください。5 分で使えなくなります。</small></p>`
      : `<p id="result" data-error="${page.failure}">${FAILURE_TEXT[page.failure]}</p>`;

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>cosense-grass のサインイン</title>
<style>${AUTH_PAGE_STYLE}</style>
</head>
<body>
${body}
<script>${AUTH_PAGE_SCRIPT}</script>
</body>
</html>
`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": await authPageCsp(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

async function cspHash(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return `sha256-${btoa(String.fromCharCode(...digest))}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
