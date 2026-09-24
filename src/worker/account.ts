/**
 * `/account` — 管理のページ (design §9、ADR-0017・0018、Issue #88)。
 * 端末の一覧と失効、合算の草と共有 URL、全データの削除。
 *
 * **なぜ Worker のページなのか。** Cosense の CSP は `connect-src` を塞いでいるので、UserScript は
 * サーバの `keys` を読めない (ADR-0001・0003)。一覧は「受信」なので画像ビーコンでは扱えない。
 * サインインした本人のブラウザが Worker のオリジンで開くページなら、その制約の外にある。
 * **破壊的な操作に Google サインインを必須にできる**のも、ここに寄せる理由 (ADR-0018)。
 *
 * - **GET は一覧**、**POST は失効か全削除**。POST の後は 303 で GET に戻す (再読み込みで二重に消さない)
 * - セッションは `session.ts` の cookie (30 分)。無ければサインインを促すだけで、何も出さない
 * - **出すのは kid と登録日時と合算の草 (画像と共有 URL) だけ。** uid も公開鍵も画面に出さない
 * - **プロジェクト別の共有 URL は出せない。** サーバはプロジェクト名を持たない (ADR-0007) ので、
 *   名前付きの一覧は Cosense のページメニュー「cosense-grass」にある
 * - **自分の kid は UserScript にしか無い**ので、この画面では「どれがこの端末か」を示せない。
 *   その代わり登録日時を出し、この端末の kid は UserScript の「設定」で見られると案内する
 * - 値をスクリプトに埋め込まない。スタイルは固定の文字列で、CSP はハッシュで書く (`auth-page.ts` と同じ)
 */
import { ACCOUNT_PATH, AUTH_START_PATH, AUTH_TO_ACCOUNT, AUTH_TO_PARAM } from "../shared/auth.ts";
import { dataKeyOf, isValidKid, PH_ALL, publicIdOf } from "../shared/ids.ts";
import { FAVICON_LINK } from "./favicon.ts";
import { csrfToken, openSession, type Session, verifyCsrf } from "./session.ts";

/** 全削除のフォームに打ち込む言葉。**押し間違いで消えないように**する (design §6 の `confirm=1` の代わり) */
export const DELETE_CONFIRM_WORD = "削除";

/** 全削除で消す表。**uid を持つ表をすべて挙げる** (新しい表を足したらここにも足す)。 */
const TABLES = ["daybits", "daily", "graphs", "keys", "enroll_tokens"] as const;

export type AccountDeps = {
  readonly db: D1Database;
  /** uid を導く鍵。cookie の署名にも使う */
  readonly secret: string;
  /** `https://grass.soui.dev`。共有 URL を作る */
  readonly publicOrigin: string;
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
  | "bad-word"
  | "deleted"
  | "d1"
  | "unconfigured";

const STYLE = `body { font-family: system-ui, sans-serif; margin: 2rem 1rem; line-height: 1.6; color: #1f2328; background: #fff; }
@media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } }
table { border-collapse: collapse; margin: 1rem 0; }
th, td { padding: 0.4rem 0.8rem; border-bottom: 1px solid #8b949e; text-align: left; }
code { word-break: break-all; }
img { max-width: 100%; }
small { color: #8b949e; }`;

/** 計算済みの CSP。**Promise ではなく文字列で持つ** (`auth-page.ts` と同じ理由) */
let cachedCsp: string | undefined;

async function devicesCsp(): Promise<string> {
  if (cachedCsp === undefined) {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(STYLE)),
    );
    const style = `sha256-${btoa(String.fromCharCode(...digest))}`;
    // 草の SVG は同じオリジンから出す。フォームの送り先は自分自身だけ
    cachedCsp = `default-src 'none'; script-src 'none'; style-src '${style}'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
  }
  return cachedCsp;
}

export async function handleAccount(request: Request, deps: AccountDeps): Promise<Response> {
  if (deps.secret === "") {
    return page(500, "unconfigured", "<p>サーバの設定が足りません。</p>");
  }
  const opened = await openSession(deps.secret, request.headers.get("cookie"), deps.now());
  if (!opened.ok) {
    return page(
      200,
      "signed-out",
      `<p>端末の一覧を見るには、Google でサインインしてください。</p>
<p><a href="${AUTH_START_PATH}?${AUTH_TO_PARAM}=${AUTH_TO_ACCOUNT}">Google でサインインする</a></p>
<p><small>サインインすると 30 分のあいだこの画面を使えます。Cosense のページメニュー「cosense-grass」→「設定」からサインインしたときも同じです。</small></p>`,
    );
  }
  const { session } = opened;

  if (request.method === "POST") {
    return act(request, session, deps);
  }
  return list(session, deps);
}

async function list(session: Session, deps: AccountDeps, notice?: string): Promise<Response> {
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
<td><form method="post" action="${ACCOUNT_PATH}"><input type="hidden" name="kid" value="${escapeHtml(device.kid)}"><input type="hidden" name="csrf" value="${escapeHtml(token)}"><button type="submit">失効させる</button></form></td>
</tr>`,
    )
    .join("\n");

  const body = `${notice ?? ""}
<h1>cosense-grass の管理</h1>

<h2>登録した端末</h2>
${
  devices.length === 0
    ? "<p>登録された端末はありません。Cosense のページメニュー「cosense-grass」→「設定」からサインインすると登録されます。</p>"
    : `<table>
<tr><th>端末の識別子</th><th>登録した日時 (UTC)</th><th></th></tr>
${rows}
</table>
<p><small>失効させた端末からは記録が送られなくなります。これまでの記録は残ります。
どれがいま使っているブラウザかは、Cosense の「cosense-grass」→「設定」に出る端末の識別子で見分けてください。</small></p>`
}

<h2>あなたの草</h2>
${await shareSection(session, deps)}

<h2>すべてのデータを削除する</h2>
<p>サーバに保存されている記録 (日ごとの集計値・ビットマップ・共有 URL・登録した端末の鍵) をすべて削除します。
<strong>元に戻せません。</strong>共有 URL の草も見られなくなります。</p>
<form method="post" action="${ACCOUNT_PATH}">
<input type="hidden" name="csrf" value="${escapeHtml(token)}">
<input type="hidden" name="action" value="delete">
<label>確認のため「${DELETE_CONFIRM_WORD}」と入力してください: <input type="text" name="word" autocomplete="off"></label>
<button type="submit">すべて削除する</button>
</form>
<p><small>お使いのブラウザに残っている記録は、Cosense の「cosense-grass」→「設定」から別に消してください。</small></p>`;
  return page(200, "listed", body);
}

/** POST は失効 (`action=revoke`) か全削除 (`action=delete`)。 */
/** 合算の草と共有 URL。**プロジェクト別は出せない** (サーバはプロジェクト名を持たない。ADR-0007)。 */
async function shareSection(session: Session, deps: AccountDeps): Promise<string> {
  const publicId = await publicIdOf(session.uid, PH_ALL);
  let exists: boolean;
  try {
    // public_id は主キー。uid では引かない (graphs に uid の索引は無い。design §5)
    exists =
      (await deps.db
        .prepare("SELECT 1 AS ok FROM graphs WHERE public_id = ?")
        .bind(publicId)
        .first()) !== null;
  } catch {
    return "<p>共有 URL を読めませんでした。</p>";
  }
  if (!exists) {
    return "<p>まだ草がありません。Cosense のページメニュー「cosense-grass」→「設定」からサインインすると作られます。</p>";
  }
  const path = `/v1/g/${publicId}.svg`;
  const url = `${deps.publicOrigin}${path}`;
  // 草の URL からは導けない鍵を並べる (ADR-0020)
  const dataUrl = `${deps.publicOrigin}/v1/g/${publicId}/${await dataKeyOf(session.uid, PH_ALL)}.json`;
  return `<p>全プロジェクトを合算した草です。<strong>URL を知っている人は誰でも見られます。</strong></p>
<img src="${escapeHtml(path)}" width="775" height="200" alt="全プロジェクトを合算した草">
<p><code>${escapeHtml(url)}</code></p>
<p>日ごとの数値 (書いた分・読んだ分・編集したページ数・作ったページ数) の JSON です。
<strong>この URL を知っている人は、草には出ない内訳まで読めます。</strong>草の URL からは作れない別の URL です。</p>
<p><code>${escapeHtml(dataUrl)}</code></p>
<p><small>プロジェクト別の草の URL は、Cosense のページメニュー「cosense-grass」にプロジェクト名つきで並びます
(サーバはプロジェクト名を持たないので、この画面では名前を出せません)。</small></p>`;
}

async function act(request: Request, session: Session, deps: AccountDeps): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return page(400, "bad-form", "<p>フォームを読めませんでした。</p>");
  }
  const csrf = form.get("csrf");
  if (typeof csrf !== "string") {
    return page(400, "bad-form", "<p>フォームの値が正しくありません。</p>");
  }
  if (!(await verifyCsrf(deps.secret, session, csrf))) {
    return page(403, "bad-csrf", "<p>画面が古くなっています。開き直してやり直してください。</p>");
  }
  return form.get("action") === "delete"
    ? deleteAll(form, session, deps)
    : revoke(form, session, deps);
}

/** 全データの削除。**合言葉を打たせる** (押し間違いで消えない)。 */
async function deleteAll(form: FormData, session: Session, deps: AccountDeps): Promise<Response> {
  if (form.get("word") !== DELETE_CONFIRM_WORD) {
    return page(
      400,
      "bad-word",
      `<p>削除するには、確認の欄に「${DELETE_CONFIRM_WORD}」と入力してください。</p>
<p><a href="${ACCOUNT_PATH}">戻る</a></p>`,
    );
  }

  let rows: number;
  try {
    // **1 回の batch で消す。** 途中で失敗したら全部戻る (batch はトランザクション)
    const results = await deps.db.batch(
      TABLES.map((table) =>
        deps.db.prepare(`DELETE FROM ${table} WHERE uid = ?`).bind(session.uid),
      ),
    );
    rows = results.reduce((total, result) => total + result.meta.changes, 0);
  } catch {
    return page(500, "d1", "<p>削除できませんでした。時間をおいてやり直してください。</p>");
  }

  return page(
    200,
    "deleted",
    `<h1>削除しました</h1>
<p>サーバに保存されていたデータ (${rows} 件) をすべて削除しました。共有 URL の草も見られなくなります。</p>
<p><strong>お使いのブラウザに残っている記録は、Cosense の「cosense-grass」→「設定」から消してください。</strong>
この画面からは消せません。</p>
<p>また使うときは、Cosense の「cosense-grass」→「設定」からサインインし直してください。</p>`,
  );
}

async function revoke(form: FormData, session: Session, deps: AccountDeps): Promise<Response> {
  const kid = form.get("kid");
  if (typeof kid !== "string" || !isValidKid(kid)) {
    return page(400, "bad-form", "<p>フォームの値が正しくありません。</p>");
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
    headers: { location: ACCOUNT_PATH, "cache-control": "no-store" },
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
${FAVICON_LINK}
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
