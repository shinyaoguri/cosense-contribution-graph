/**
 * `/auth/devices` — 登録済みのデバイスの一覧と失効 (design §9、ADR-0017、段階 8、Issue #79)。
 *
 * **なぜ Worker のページなのか。** Cosense の CSP は `connect-src` を塞いでいるので、UserScript は
 * サーバの `keys` を読めない (ADR-0001・0003)。一覧は「受信」なので画像ビーコンでは扱えない。
 * サインインした本人のブラウザが Worker のオリジンで開くページなら、その制約の外にある。
 *
 * - **GET は一覧**、**POST は 1 台の失効**。POST の後は 303 で GET に戻す (再読み込みで二重に消さない)
 * - セッションは `session.ts` の cookie (30 分)。無ければサインインを促すだけで、何も出さない
 * - **出すのは kid と登録日時だけ。** uid も公開鍵も画面に出さない
 * - **自分の kid は UserScript にしか無い**ので、この画面では「どれがこの端末か」を示せない。
 *   その代わり登録日時を出し、この端末の kid は「草の設定」で見られると案内する
 * - 値をスクリプトに埋め込まない。スクリプトもスタイルも固定の文字列で、CSP はハッシュで書く (`auth-page.ts` と同じ)
 */
import { AUTH_DEVICES_PATH, AUTH_START_PATH } from "../shared/auth.ts";
import { isValidKid } from "../shared/ids.ts";
import { csrfToken, openSession, type Session, verifyCsrf } from "./session.ts";

export const DEVICES_PATH = AUTH_DEVICES_PATH;

export type DevicesDeps = {
  readonly db: D1Database;
  /** uid を導く鍵。cookie の署名にも使う */
  readonly secret: string;
  /** 現在時刻 (ミリ秒)。テストで固定する */
  readonly now: () => number;
};

type Device = {
  readonly kid: string;
  /** 登録した時刻 (unix 秒) */
  readonly created: number;
};

/** ログに出す結果。値そのもの (uid・kid) は出さない。 */
type Reason =
  | "signed-out"
  | "listed"
  | "revoked"
  | "absent"
  | "bad-form"
  | "bad-csrf"
  | "d1"
  | "unconfigured";

const STYLE = `body { font-family: system-ui, sans-serif; margin: 2rem 1rem; line-height: 1.6; color: #1f2328; background: #fff; }
@media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } }
table { border-collapse: collapse; margin: 1rem 0; }
th, td { padding: 0.4rem 0.8rem; border-bottom: 1px solid #8b949e; text-align: left; }
code { word-break: break-all; }
small { color: #8b949e; }`;

/** 計算済みの CSP。**Promise ではなく文字列で持つ** (`auth-page.ts` と同じ理由) */
let cachedCsp: string | undefined;

async function devicesCsp(): Promise<string> {
  if (cachedCsp === undefined) {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(STYLE)),
    );
    const style = `sha256-${btoa(String.fromCharCode(...digest))}`;
    // フォームの送り先は自分自身だけ
    cachedCsp = `default-src 'none'; script-src 'none'; style-src '${style}'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
  }
  return cachedCsp;
}

export async function handleDevices(request: Request, deps: DevicesDeps): Promise<Response> {
  if (deps.secret === "") {
    return page(500, "unconfigured", "<p>サーバの設定が足りません。</p>");
  }
  const opened = await openSession(deps.secret, request.headers.get("cookie"), deps.now());
  if (!opened.ok) {
    return page(
      200,
      "signed-out",
      `<p>端末の一覧を見るには、Google でサインインしてください。</p>
<p><a href="${AUTH_START_PATH}">Google でサインインする</a></p>
<p><small>サインインすると 30 分のあいだこの画面を使えます。Cosense の「草の設定」からサインインしたときも同じです。</small></p>`,
    );
  }
  const { session } = opened;

  if (request.method === "POST") {
    return revoke(request, session, deps);
  }
  return list(session, deps);
}

async function list(session: Session, deps: DevicesDeps, notice?: string): Promise<Response> {
  let devices: Device[];
  try {
    const { results } = await deps.db
      .prepare("SELECT kid, created FROM keys WHERE uid = ? ORDER BY created, kid")
      .bind(session.uid)
      .all<Device>();
    devices = results;
  } catch {
    return page(500, "d1", "<p>一覧を読めませんでした。時間をおいてやり直してください。</p>");
  }

  const token = await csrfToken(deps.secret, session);
  const rows = devices
    .map(
      (device) => `<tr>
<td><code>${escapeHtml(device.kid)}</code></td>
<td>${escapeHtml(formatTime(device.created))}</td>
<td><form method="post" action="${DEVICES_PATH}"><input type="hidden" name="kid" value="${escapeHtml(device.kid)}"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button type="submit">失効させる</button></form></td>
</tr>`,
    )
    .join("\n");

  const body = `${notice ?? ""}
<h1>登録した端末</h1>
${
  devices.length === 0
    ? "<p>登録された端末はありません。</p>"
    : `<table>
<tr><th>端末の識別子</th><th>登録した日時 (UTC)</th><th></th></tr>
${rows}
</table>
<p><small>失効させた端末からは記録が送られなくなります。これまでの記録は残ります。
この端末の識別子は Cosense の「草の設定」で見られます。</small></p>`
}`;
  return page(200, "listed", body);
}

async function revoke(request: Request, session: Session, deps: DevicesDeps): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return page(400, "bad-form", "<p>フォームを読めませんでした。</p>");
  }
  const kid = form.get("kid");
  const csrf = form.get("csrf");
  if (typeof kid !== "string" || !isValidKid(kid) || typeof csrf !== "string") {
    return page(400, "bad-form", "<p>フォームの値が正しくありません。</p>");
  }
  if (!(await verifyCsrf(deps.secret, session, csrf))) {
    return page(403, "bad-csrf", "<p>画面が古くなっています。開き直してやり直してください。</p>");
  }

  let removed: boolean;
  try {
    const result = await deps.db
      .prepare("DELETE FROM keys WHERE uid = ? AND kid = ?")
      .bind(session.uid, kid)
      .run();
    removed = result.meta.changes > 0;
  } catch {
    return page(500, "d1", "<p>失効させられませんでした。時間をおいてやり直してください。</p>");
  }

  log(303, removed ? "revoked" : "absent");
  // **再読み込みで二重に消さない** (POST の結果は 303 で GET に返す)
  return new Response(null, {
    status: 303,
    headers: { location: DEVICES_PATH, "cache-control": "no-store" },
  });
}

async function page(
  status: 200 | 400 | 403 | 500,
  reason: Reason,
  body: string,
): Promise<Response> {
  log(status, reason);
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>cosense-grass の端末</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": await devicesCsp(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16);
}

/** Workers Logs に 1 行。**uid・kid は出さない** (ADR-0013 決定 1)。 */
function log(status: number, reason: Reason): void {
  console.log(JSON.stringify({ event: "devices", status, reason }));
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
