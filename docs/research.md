# 実測結果 — Cosense の制約調査

調査日 2026-09-12。このツールの設計はここに書かれた事実の上に立っている。
Cosense の内部 API は[公式が「予告なく変更する」と明言している](https://scrapbox.io/help-jp/API)ので、
**動作がおかしくなったら、まずこの文書の事実が今も成り立っているかを確認する**こと。

値の基準日を必ず添えてある。数値や構文を書き換えるときは基準日も更新する。

---

## 1. Content-Security-Policy (最重要)

### 実ヘッダ (2026-09-11 取得、プロジェクトによらず同一)

```
default-src 'self';
base-uri 'self';
font-src 'self' cdnjs.cloudflare.com fonts.gstatic.com;
form-action 'self';
frame-ancestors 'self';
img-src * data: blob:;
object-src 'none';
script-src 'self' cdnjs.cloudflare.com maps.googleapis.com 'unsafe-eval'
           helpfeel-tweaks.helpfeel.com www.google.com www.gstatic.com;
script-src-attr 'none';
style-src 'self' fonts.googleapis.com cdnjs.cloudflare.com 'unsafe-inline'
          helpfeel-tweaks.helpfeel.com;
connect-src 'self' i.gyazo.com t.gyazo.com wss://scrapbox.io
            api.openai.com *.openai.azure.com maps.googleapis.com
            bedrock.ap-northeast-1.amazonaws.com bedrock-runtime.ap-northeast-1.amazonaws.com
            bedrock-agent.ap-northeast-1.amazonaws.com bedrock-agent-runtime.ap-northeast-1.amazonaws.com
            https://upload.gyazo.com https://storage.googleapis.com
            https://sentry.io www.google.com;
frame-src 'self' www.google.com www.youtube.com player.vimeo.com anchor.fm
          podcasters.spotify.com creators.spotify.com open.spotify.com
          gyazo.com *.gyazo.com helpfeel-tweaks.helpfeel.com dashboard.helpfeel.com;
media-src *;
worker-src 'self';
upgrade-insecure-requests
```

`connect-src` は allowlist なので、**自前ドメインへの `fetch` / XHR / WebSocket / `sendBeacon` は通らない**。
`img-src *` と `media-src *` だけが外部へ開いた出口。

CSP は時間とともに変わる。2023-09 に OpenAI、2024 年に AWS Bedrock が `connect-src` へ追加された
履歴があるので、将来 allowlist に自前ドメインを置ける見込みはない。
過去のヘッダ記録: [villagepump/ScrapboxのCSP](https://scrapbox.io/villagepump/ScrapboxのCSP)

### scrapbox.io のページ内で実行した検証 (2026-09-12)

| 試行 | 結果 |
|---|---|
| `fetch("https://example.com/", {mode:"no-cors"})` | `TypeError: Failed to fetch`。`securitypolicyviolation` が `connect-src` で発火 |
| `navigator.sendBeacon("https://example.com/", "x")` | **戻り値は `true`** だが同じく `connect-src` 違反が発火。キューに入っただけで送信はブロックされる |
| `new Image().src = "https://placehold.co/1x1.png?kusa=...&t=..."` | `onload` 10x10。CSP 違反なし |
| `new Image().src = "https://www.google.com/favicon.ico?kusa=...&t=..."` | `onload` 32x32。CSP 違反なし |
| 同じ画像に `crossOrigin="anonymous"` を付けた場合 | `onerror`。先方が `Access-Control-Allow-Origin` を返さないため。CSP 違反ではない |

結論。**外部ドメインへのクエリ付き GET は通る。** `sendBeacon` の戻り値は送信成否の判定に使えない。

`report-uri` / `report-to` が設定されていなくても `securitypolicyviolation` イベントは発火するので、
出口が塞がれたかをクライアント JS だけで検知できる
([CSP3 §5.5](https://www.w3.org/TR/CSP3/) — イベント発火とレポート送信は別の条件分岐)。

### 画像リクエストの仕様上の制約

- 画像は `keepalive` を持てない。ページ破棄時に
  [Fetch 仕様の fetch group termination](https://fetch.spec.whatwg.org/#fetch-groups) で**中断される**。
  これが `sendBeacon` / `fetch(keepalive)` が推奨される理由そのもの
- `new Image()` を DOM に挿入しなくてもフェッチは開始し、フェッチ中は
  [HTML 仕様が document からの強参照を保証する](https://html.spec.whatwg.org/multipage/images.html#updating-the-image-data)
  ので GC で中断されない
- `onload` / `onerror` は HTTP ステータスではなく**デコード可能な画像が返ったか**で決まる。
  404 でも有効な画像バイト列を返せば `onload`、200 でも非画像なら `onerror`。
  `204 No Content` は本文が空なので `onerror`
- `crossorigin` を付けた CORS モードの画像も CSP では `img-src` の管轄。
  effective directive は request の `destination` で決まり、`destination` は `"image"` のまま
  ([CSP3 §6.8.1](https://www.w3.org/TR/CSP3/), [Fetch Standard](https://fetch.spec.whatwg.org/#concept-request-destination))
- 既定の Referrer-Policy は `strict-origin-when-cross-origin` なので、クロスオリジン画像には
  origin しか送られない。`img.referrerPolicy = "no-referrer"` を `src` より前に設定すれば origin も出ない
- URL 上限は **Cloudflare の 16KB** が実効のボトルネック
  ([Workers Limits](https://developers.cloudflare.com/workers/platform/limits/))。
  ブラウザ側は Chrome 2MB、Safari 約 80,000 文字、Firefox 約 65,536 文字 (後者2つは二次情報)

### Cosense の Service Worker が画像リクエストを作り直す (2026-09-14)

**Service Worker がページを制御していると、上の `no-referrer` は効かない。** 届く Referer はオリジンだけ
(`https://scrapbox.io/`) で、**プロジェクト名もページ名も含まない。** UserScript から `/v1/probe.gif` へ送った実測と、
Service Worker のコードの両方で確かめた (Issue #31)。

実測。Chrome で、自分のページの UserScript から送った (2026-09-14 JST)。**送ったものはすべて届き、中身も壊れなかった。**

| 時刻 | プロジェクト | ページの制御 | 送ったもの | Referer | `Sec-Fetch-Dest` |
|---|---|---|---|---|---|
| 0:18〜0:20 | 公開 | (記録なし) | 240 / 8,000 / 15,000 文字、タブを隠したとき | あり (形は測っていない) | `image` 以外 |
| 9:55 | 公開 | (記録なし) | 同上 | なし | `image` |
| 10:04 | 公開 | **制御外** (強制再読み込み) | 240 / 8,000 / 15,000 文字 | なし | `image` |
| 10:07:16 | 非公開 | **制御下** | タブを隠したときの 240 文字 | **オリジンだけ** | `image` 以外 |
| 10:07:44 | 非公開 | **制御外** | 240 / 8,000 / 15,000 文字 | なし | `image` |

「ページの制御」は `navigator.serviceWorker.controller` の有無。最初の 2 回はまだ記録していなかったが、
Referer と `Sec-Fetch-Dest` の組み合わせから、0:20 は制御下、9:55 は制御外だったと読める。

原因。`https://scrapbox.io/serviceworker.js` の画像の経路 (`respondImageNetworkFirst`) は
**`fetch(request, { mode: request.mode, credentials: request.credentials })`** で送り直している。
fetch のハンドラは、https・GET・destination が image・Gyazo のアップロードでない、といった条件で横取りするので、
**制御下のページからの画像ビーコンは毎回ここを通る。**

- [Fetch 仕様の `new Request(input, init)`](https://fetch.spec.whatwg.org/#dom-request) は、init が空でないとき
  request の referrer を `"client"` に、referrer policy を空に戻す。**ページで付けた `no-referrer` はここで捨てられる**
- 新しい request は destination を引き継がないので空になり、`Sec-Fetch-Dest: empty` で届く
- referrer は Service Worker 自身の URL になる。`serviceworker.js` の応答に `Referrer-Policy` ヘッダが無いので
  既定の `strict-origin-when-cross-origin` が効き、クロスオリジンなので**オリジンだけに切り詰められる**。
  アプリのページは `referrer-policy: no-referrer` を返しているが、Service Worker の fetch には効かない
- 強制再読み込み (Cmd+Shift+R) で開いたページは制御外になり、ページの `no-referrer` がそのまま効く
- 画像の応答は URL をキーに Cache Storage へ保存される (ADR-0001 の 2026-09-12 の改訂に既出)
- **制御下でも、作り直された画像リクエストの応答から `naturalWidth` が読める。** 署名つきの記録 (`/v1/p.gif`、約 1,240 文字) を
  制御下で自動送信し、URL が壊れずに届いて (署名の検証が通り) 幅 16 が読めた (2026-09-14、§2 の「自動のきっかけでの記録の送信」)

**測れていないこと。**

- 公開プロジェクトの制御下で Referer の形。referrer は Service Worker の URL から作られ、プロジェクトに依らないので、
  非公開と同じオリジンだけになるはず
- Chrome 以外のブラウザ

### 検討して却下した他の出口

- `storage.googleapis.com` が `connect-src` にあるが、GCS への書き込みには署名が必要で、
  署名の取得経路が自前サーバになるため循環する。公開書き込みバケットは荒らしと課金のリスク
- `sentry.io` が `connect-src` にある。Sentry の公開 DSN は客体側に埋め込む設計なので技術的には
  データを流せるが、イベント枠の濫用であり不適切
- `media-src *` で `<video>` / `<audio>` を使うと request destination が `"audio"` / `"video"` になり
  Cosense の Service Worker の画像ルーティングをすり抜ける。ただし Range 分割と `preload` 遅延があり
  画像より不確実
- top-level navigation は CSP の管轄外 (`navigate-to` は 2022 年に仕様から削除)。ページ遷移を伴うので実用外
- `<link rel="dns-prefetch">` はホスト名しか運べない
- Tampermonkey の `GM_xmlhttpRequest` は CSP を越えられるが、1行導入の要件を捨てることになる

---

## 2. UserScript の実行環境

[公式ヘルプ](https://scrapbox.io/help-jp/UserScript) と、Cosense 本体のバンドル
(`https://scrapbox.io/assets/chunks/chunk-B4OOUBCQ.js` 内の `UserScript` ストア) を読んで確定した。

**2026-09-14 に読み直した** (段階 5 のセンサーの前提、Issue #49)。そのときの本体は `https://scrapbox.io/assets/index.js` が読む
`chunks/chunk-ZEIOSPH4.js` で、`chunk-B4OOUBCQ.js` はもう無い。ページ・行・保存処理・UserScript のストアはすべてこの chunk にある。
**chunk の名前は配信のたびに変わる**ので、読み直すときは `index.js` の import から辿る。

### 評価方法

```js
let n = document.createElement("script");
n.async = true;
n.setAttribute("src", this.src);
n.setAttribute("type", "module");
n.setAttribute("crossorigin", "use-credentials");
n.id = "user-script";
document.getElementsByTagName("body")[0].appendChild(n);
```

`src` は `/api/code/{project}/{CurrentUser.name}/script.js?{Date.now()}`。

- `type="module"` なのでトップレベル `import` と `await` が使える
- **`crossorigin="use-credentials"` が致命的**。module script の credentials mode は子孫 import にも
  継承され、credentials mode が `include` だと `Access-Control-Allow-Origin: *` は拒否される
  (厳密なオリジンエコーと `Access-Control-Allow-Credentials: true` が必要)。
  つまり **Worker から `/v1/s.js` を import させる設計は成立しない**
- `async` なのでアプリ初期化との順序保証がない

### 実行条件

- ユーザー設定の `config.userScript` が有効 (Settings → Extensions)
- `CurrentProject.isMember` が true。**ゲスト閲覧では動かない**
- 書く場所は「そのプロジェクト内の、自分のユーザー名と同じタイトルのページ」の `code:script.js` だけ。
  settings ページに書いても効かない

### 配布ページからの import (2026-09-14 実測)

**公開プロジェクトの配布ページからの import は、非公開プロジェクトでも動く** (ADR-0005 の前提。Issue #31)。
Chrome で、公開プロジェクト `/shinyaoguri` の `cosense-grass-probe` ページにバンドルを置き、
公開プロジェクトと持ち主の非公開プロジェクトの両方で、自分のページに次の 1 行だけを書いた。
どちらでもページメニューに疎通確認の項目が出た。

```
code:script.js
 import "/api/code/shinyaoguri/cosense-grass-probe/script.js"
```

**2026-09-14 に配布先を専用の公開プロジェクト `/cosense-grass` に移した** (ADR-0005 の改訂、#46)。上の実測は移す前のページで行った。

**配布ページを差し替えても承認は求められなかった。** 自分のページの `script.js` が変わらないので SHA1 が一致する
(下の「SHA1 承認ゲート」のとおり)。

自分のページの `code:script.js` は、ページ内のすべての `code:script.js` を上から連結した 1 つのファイルとして
配信される。既存の UserScript と並べて置いても、配布側は import の 1 行を足すだけでよい。

### 配布ページの `script.js` はエッジで 2 時間キャッシュされる (2026-09-14 実測)

**`https://scrapbox.io/api/code/<project>/<page>/script.js` は Cloudflare のエッジにキャッシュされる。** 元のサーバの応答に
`Cache-Control` が無く、`cf-cache-status: HIT` と `age` が付いて返る。#46 で消した旧配布ページを、クエリを付けない `curl` で
2 分ごとに取得して測った。

| 時刻 (UTC) | 応答 |
|---|---|
| 07:08:50 | エッジが取得した時刻 (`last-modified` と `age` から逆算) |
| 07:30 までに | 持ち主がページを消した。07:30 にページ API (`/api/pages/...`) が 404 を返した |
| 07:31〜09:07 | **200 のまま** (`HIT`、`age` は 1,376 から 7,140 まで増えた)。消した後も中身が返った |
| 09:09:51 | 404 (`cf-cache-status: EXPIRED`) |

- **期限は 7,200 秒 (2 時間)。** `Cache-Control` の無い 200 に Cloudflare が付ける既定のエッジの期限と合う
- **ページを消してもキャッシュは消されない**
- 同じ URL にキャッシュを避けるクエリ (`?nocache=<時刻>`) を付けると、元のサーバの値 (404) が返る
- `/api/pages/...` は `cf-cache-status: DYNAMIC` で、キャッシュされない

**ただし、持ち主のブラウザ (ログイン済み) には、配布ページの貼り替えが 2 時間を待たずに届いた。**

- 14:45〜14:53 (JST) に #41 の版で送った後、#44 の版に貼り替えた
- 15:23 の読み込みで、#44 で足した自動送信が動いた
- 届いた理由は確かめていない。ページの編集でキャッシュが消されるのか、ログイン済みのリクエスト (Cookie つき) はエッジのキャッシュを通らないのか、のどちらか

**影響。**

- **ログインしていない経路で配布ページを見ると、最長 2 時間古い中身を見る。** CI で配布ページの古さを見張るとき (#47) は、クエリを付けて元のサーバの値を取る
- 利用者のブラウザにも遅れが出うるかは、上の理由が分かるまで断定しない。貼り替えた直後に確かめるときは、ページを開き直して自動送信やメニューの動きで版を見分ける

### SHA1 承認ゲート

本体が script.js を fetch して SHA1 を計算し、localStorage の `userScriptSHA1[projectId]` と比較する。
不一致なら**タグを注入せず**、「新しいUserScriptを読み込む」バナーを出す。

つまり **`code:script.js` の中身を書き換えるたび、リロード後に手動承認が1回必要**。
逆に言えば、script.js を1行の `import` に固定しておけば、import 先を更新しても承認は要らない。
これが「配布ページを別に置く」方式の実務上の利点。

### 自動のきっかけでの記録の送信 (2026-09-14 実測)

**クリック無しでも、UserScript は IndexedDB から鍵を読み、署名し、画像 GET で送り切れる** (Chrome、#36・#44)。
ページを読み込んだとき (UserScript の実行直後) と `visibilitychange` の hidden のときに、署名つきの記録を自動で送った。
4 回すべてが「変化なし (幅 16)」だった。幅 16 は Worker が署名を検証した後にしか返らない。

| 開き方 | きっかけ | Service Worker | きっかけから結果まで |
|---|---|---|---|
| 強制再読み込み | 読み込み時 | 制御外 | 1.3 秒 |
| 強制再読み込み | タブを隠したとき | 制御外 | 0.1 秒 |
| 通常の再読み込み | 読み込み時 | 制御下 | 0.8 秒 |
| 通常の再読み込み | タブを隠したとき | 制御下 | 1.2 秒 |

- IndexedDB の読み出しと WebCrypto の署名は、ユーザー操作 (transient activation) を要求しない。仕様どおりの結果
- 所要時間は、前の送信を待った時間を含む
- タブを閉じたとき、凍結されたタブ、Chrome 以外は測っていない

### 常駐

```js
let r = () => {
  ["list","page","stream"].includes(Layout.get())
    && e !== CurrentProject.name
    && (e = CurrentProject.name, this.reload())
}
```

再読込するのは**プロジェクト名が変わったときだけ**。プロジェクト内のページ遷移では再読込されず、
モジュールインスタンスがそのまま生き続ける。プロジェクトを移ると再注入される。

DOM に挿した要素は遷移で消えるので、`page:changed` / `layout:changed` で再マウントと後片付けが必要。

#### 配布モジュールは 1 ドキュメントで 1 回しか評価されない (2026-09-14、実装と仕様から。実機で未確認)

再注入は、古い `#user-script` タグを外し、`src` に `?{Date.now()}` を付けた新しいタグを足す (`removeUserScriptTag` と
`renderUserScriptTag`)。**自分のページの `script.js` は URL が毎回違うので、プロジェクトを移るたびに評価し直される。**

一方、その中の `import "/api/code/cosense-grass/v1/script.js"` は固定の URL。モジュールマップは URL で引かれるので
([HTML Standard の module map](https://html.spec.whatwg.org/multipage/webappapis.html#module-map))、
**2 回目以降の import はキャッシュされたモジュールを返し、本体を評価しない。** タグを外しても、評価済みのモジュールが
登録したタイマーやリスナーは残る。

- **最初に読み込んだプロジェクトで 1 回だけ評価され、アプリ内でどのプロジェクトへ移っても動き続ける**
- 移った先の自分のページに import の 1 行が無くても、UserScript が無効でも、メンバーでなくても止まらない。
  **「1 行書かなければ記録されない」(ADR-0007 決定 5) は、モジュールの側で今のプロジェクトを確かめないと成り立たない**
- 別の URL (`dev` と `v1`) を別々のプロジェクトで import すると、それぞれ 1 回ずつ評価される
- 移った先で評価し直されないので、`Project.name` を読み込み時に 1 回だけ読むと古い値を使い続ける

### `window.scrapbox` API

`window.scrapbox` は `window.cosense` のエイリアスで、実体は `events` の EventEmitter。

イベントは5つだけ。すべて `requestAnimationFrame` 越しに1フレーム遅延する。

| イベント | ペイロード |
|---|---|
| `lines:changed` | `{by}` |
| `page:changed` | なし。`event === "load"` かつタイトルが変わったときのみ |
| `project:changed` | なし。同様にプロジェクト名が変わったときのみ |
| `layout:changed` | なし。値が変わったときのみ |
| `infobox:changed` | `{by}` |

**`lines:changed` の `by` で発火元が判別できる** (2024-10-03 のリリースノートで追加)。

| `by` | 意味 |
|---|---|
| `edit` | 自分のローカル編集 |
| `remote` | WebSocket で届いた他ユーザーのコミット |
| `navigation` | ページロードに伴う行の入れ替え |
| `userscript` | UserScript 自身による `insertLine` / `updateLine` |

この `{by}` は [`@cosense/types`](https://github.com/scrapbox-jp/types) の `eventName.ts` には型がない。
イベント名の union だけで、型定義がランタイムに追いついていない。

各行のプロパティ (`BaseLine`) には `userId` / `created` / `updated` がある。

#### 2026-09-14 に読み直して分かったこと

**`by` は上の 4 つだけではない。** 行ストアの変更通知の `event?.by` をそのまま渡しているので、`event` を付けずに
通知する経路では **`undefined`** になる。

| 経路 | `by` |
|---|---|
| 元に戻す / やり直し (`p.Line.emitChange()`) | `undefined`。自分の編集で、実際に送信される |
| 元に戻せず衝突したときの `setLines` | `undefined` |
| キー入力のほか、URL の `?body=` による挿入、ユーザーページの雛形、ページのコピー、アップロードや AI の挿入 | `edit` |
| ページ履歴のスナップショットの表示 | `navigation` |
| 受信したコミットの適用 (socket 経由と、再接続時の取り直し) | `remote`。**別のタブや端末での自分の編集もここに入るはず** (推測) |

- 1 回の操作で `edit` が複数回出ることがある (最終行より後への入力で空行を足す分、ブロックの左右移動は行ごと)
- **ページの保存が完了したときには `lines:changed` も `page:changed` も出ない**

**`scrapbox.Page` のゲッターは、Layout が `page` 以外だとすべて `null` を返す。**

```js
get id() { return p.Layout.get() !== "page" ? null : p.Page.id; },
```

- ゲッターは `created` / `updated` / `lines` / `title` / `id` / `metadata` / `cursor` / `selection`
- `id` はページを読み込んだ API の応答から付く。保存のコミットは `pageId: p.Page.id` で作るので、
  **まだ保存されていないページ (プレースホルダー) にも ID があり、保存しても変わらない** (実機で未確認)
- `created` / `updated` は読み込み時の応答のままで、その後のコミットでは更新されない
- `lines` はまだ保存していない手元の編集も含む

**ページが保存済み (`persistent`) かを知る公開 API は無い。** ストアは chunk のローカル変数で、window に出ていない。
保存が完了すると内部の `Page.persistent` が `true` になるが、イベント名の無い通知なので UserScript には届かない。
間接的に知る手段は次のとおり。

| 手段 | 弱点 |
|---|---|
| 同一オリジンの REST `/api/pages/v2/:project/:title` の `persistent` (`connect-src 'self'` なので通る) | 1 回ごとにリクエストが要る |
| DOM の `main.page.not-persistent` クラス | 非公開の実装 |
| `scrapbox.Project.pages` の `exists` | 読むたびに検索候補を全件複製する |

**その他。**

- `scrapbox.on` / `once` / `off` がある (`off` は `removeListener` の別名)。1 イベントに 10 本を超えると警告が出る
- `scrapbox.User` は `name` / `email` / `uiLanguage` だけで **id が無い**。id は `/api/users/me` で取る
- `Layout` は `page` / `list` / `stream` のほか、`settings-*-page` や `project-settings-*-page` など 30 以上の値を取る
- `page:changed` はプロジェクト内のページ遷移で出るが、**出ない場合がある。** ページ A → 一覧 → ページ A と戻ったとき、
  リネームや `/new` でタイトルが確定したとき、別プロジェクトの同名ページへ移ったとき。UserScript は非同期で注入されるので、
  読み込み時のページの `page:changed` はもう過ぎている
- 行の `userId` は**最終更新者** (作成者ではない)。`created` は行を挿入した時刻、`updated` は本文を最後に更新した時刻 (秒)
- 型定義は main (2026-07-14 に本体と同期) にあり、JSR の最新版 0.11.7 (2025-09-30) には `User` や `Page.created` が無い

---

## 3. 画像としての SVG 表示

### 判定は拡張子 (確定)

本体バンドルの `normalizeIconUrl`:

```js
function normalizeIconUrl(e){
  e = e.replace(/\?.+$/, "");
  /\.(png|jpe?g|gif|svg)$/i.test(e) || (e += "#.png");
  return e
}
```

- `svg` は本体バンドルにもパーサにも入っている。**SVG は画像として展開される**
- **実際の Worker に対して端から端まで成立した (2026-09-13)。** `workers.dev` にデプロイした
  `/v1/g/demo.svg` (`Content-Type: image/svg+xml; charset=utf-8`、`width` / `height` / `viewBox` 付き)
  を `[ ]` 記法で Cosense のページに貼り、表示されることを確認した (Issue #20)
- クエリパラメータ付きでも `[ ]` 単体記法なら展開される (実レンダリングで確認)
- `[[ ]]` (strongImage) の正規表現にはクエリ許容部がないので、**クエリ付き URL は `[ ]` で貼る**
- 拡張子のない URL も末尾に `#.png` を付ければ画像化できる
- `webp` は [progfay/scrapbox-parser](https://github.com/progfay/scrapbox-parser) にはあるが
  本体バンドルの該当箇所では未確認

### SVG が表示されない唯一の落とし穴

Cosense は拡張子を見て `<img>` にするかを決め、描画できるかはブラウザが Content-Type で決める。
`/api/code/.../test.svg` が表示されなかった事例は `Content-Type: text/plain` が返っていたため。

**自分のサーバから配信するなら `Content-Type: image/svg+xml` を必ず付ける。**

既知の注意点 ([scrapboxlab/SVG](https://scrapbox.io/scrapboxlab/SVG)):

- `width` / `height` / `viewBox` の3つを埋める。埋めないとサイズが崩れ、拡大表示も小さくなる
- 画像全体が `<a>` で包まれるので、SVG 内部のリンクはクリックできない

### キャッシュ (グラフの鮮度に直結)

- **Cosense 側にプロキシもサーバキャッシュもない。** `<img src>`、ページの `image` フィールド、
  `og:image` すべて生 URL をそのまま持つ。Gyazo だけ `/thumb/1000` を付ける特別扱い
- Service Worker は画像を **network-first** で扱う。毎回 `fetch()` してから保存し、
  キャッシュを返すのは fetch が throw したとき (オフライン等) だけ。48 時間で失効し、
  ストレージ使用量が quota の 20% を超えると画像キャッシュを全消去する

つまり**鮮度は自分のサーバの `Cache-Control` で完全に制御できる**。短い `max-age` を返すこと。

---

## 4. REST API

型の一次情報は公式 org の [scrapbox-jp/types](https://github.com/scrapbox-jp/types)
(npm / JSR の `@cosense/types`)。ただし実 API に少し遅れている。

### `/api/users/me`

`id` / `name` / `displayName` / `photo` / `email` / `provider` / `created` / `updated` / `csrfToken` /
`config.{userScript, emacsBinding}`。未ログインは `{isGuest: true, csrfToken}` だけ。

型定義にない `uiLanguage` も実際には返る。

### `/api/pages/:project`

- `limit` の上限は **1000。超えてもエラーにならず黙ってクランプされる**
- `sort` は `updated` / `created` / `accessed` / `linked` / `views` / `title` / `updatedbyMe`
- `skip` は大きいと遅くなる
- 型定義にない **`users: [{id}]` (そのページの編集者一覧) が実際に返る**
- `commitId` / `snapshotCreated` / `pageRank` は返らない

### `/api/pages/:project/:title`

- **`created` / `updated` は秒。** ミリ秒が必要なら 1000 倍する
- `lines[]` の各要素に `userId` / `created` / `updated` がある
- 未ドキュメントの `/api/pages/v2/:project/:title` もあり、`relatedPages` を含まないので軽い。
  変更リスクは v1 より高いと見るべき

### `/api/commits/:project/:pageId`

`{commits: [{id, parentId, pageId, userId, created, changes, kind}]}`。`created` は秒。

`changes` の型は `InsertChange` / `UpdateChange` / `DeleteChange` / `LinksChange` /
`ProjectLinksChange` / `IconsChange` / `DescriptionsChange` / `ImageChange` / `FilesChange` /
`HelpFeelsChange` / `InfoboxDefinitionChange` / `TitleChange` / `LinesCountChange` /
`CharsCountChange` / `PinChange`。

**2つの重大な制約がある。**

1. **メンバーでないと 403** (`NotMemberError`)。公開プロジェクトでも同じ。未ログインは 401
2. **最終更新から約 30 日で消える。** personal プランの実測値:

   | 最終更新からの経過 | commit 数 |
   |---|---|
   | 12 時間 | 7 |
   | 6 日 | 212 |
   | 2 週 | 23 |
   | 3 週 | 11 |
   | 23 日 | 34 |
   | **32 日** | **0** |
   | 1 ヶ月超 (8 ページ) | すべて 0 |

   プラン依存かは未確認 (personal プランでのみ実測)。

したがって**長期の活動履歴を commits から復元することはできない**。

代替は `lines[].userId` と `lines[].created` による近似だが、削除・上書きされた行の履歴は失われるので
常に過小評価になる。

### ページリネーム時のリンク一括更新

- API は `POST /api/pages/:project/replace/links`、body は `{from, to}`、`X-CSRF-TOKEN` 必須
- **被リンクページに生成される commit が誰に帰属するかは未確認。** API の認証形態からは
  リネーム実行者になる可能性が高いが、帰属を明記した一次情報は見つからなかった
- 対策は `changes` の型で判別する方が確実。`LinksChange` / `IconsChange` / `TitleChange` だけの
  commit を活動から除外する

### レート制限

文書化された記述は見つからなかった。`help-jp/API` にも記載なし。数十リクエストを短時間に投げても
429 は出なかったが、無いことの証明ではない。内部 API なので控えめな並列度とバックオフで扱う。

### 書き込み REST (公式)

`@helpfeel/cosense-cli` が使っている。ブラウザ UI は使っていないエージェント専用ルート。

```
POST {origin}/api/pages/v2/{project}/page-edit-for-ai/preview
  body: { pageId?, changes }   → { previewId, expireAt, pagePreview }   // 5分で expire
POST {origin}/api/pages/v2/{project}/page-edit-for-ai/submit
  body: { previewId }          → { commitId, title, ... }               // previewId は1回限り
```

認証ヘッダは `x-personal-access-token` か `x-service-account-access-key`。
**`Authorization: Bearer` ではない。**
Personal Access Token は全ユーザーが `https://scrapbox.io/settings/personal-access-tokens` で発行でき、
スコープの概念はない (そのユーザーが見られる範囲すべて)。

エラー: 400 別プロジェクト / 401 未認証 / 403 権限不足 / 404 preview 不在・期限切れ・消費済み /
409 `NotFastForward` か `DuplicateTitle` / 422 ops 不正。

`/api/code/{project}/{page}/{filename}` は拡張子から MIME を決めるので、`.json` なら
`application/json` で返る。公開プロジェクトなら未認証で読める。

---

## 5. Cloudflare 側の制約

### D1

基準日 2026-04-21 ([D1 Limits](https://developers.cloudflare.com/d1/platform/limits/))。

| 項目 | Free | Paid |
|---|---|---|
| DB サイズ | 500 MB | 10 GB |
| Worker 1 回あたりのクエリ数 | **50** | 1000 |
| 1 クエリのバインドパラメータ数 | **100** | 100 |
| 日次 rows read | 5,000,000 | — |
| 日次 rows written | **100,000** | — |
| SQL ステートメント長 | 100 KB | 100 KB |
| クエリ実行時間 | 30 秒 (batch 全体に適用) | 同 |

**2026-09-01 から Free プランの日次 row read / write 上限が実際に強制される。**
超えると UTC 0 時までクエリがエラーを返す
([changelog](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/))。

`db.batch()` のステートメント数上限は公式に数値がない。実効の縛りは「1 invocation のクエリ数」と
「30 秒が batch 全体に適用される」こと。

rows read は**スキャンした行数**でカウントされる。返した行数ではない。

### SQLite の構文 (指示書のコードのままでは通らない点)

- `INSERT ... SELECT ... ON CONFLICT` は `ON` がJOIN の ON 節と曖昧になるため、
  [公式が `WHERE true` を常に入れることを指示している](https://www.sqlite.org/lang_upsert.html)
- `DO UPDATE SET x = max(x, excluded.x)` の裸のカラム名は既存行の値を指すので意味は合うが、
  テーブル名で修飾する方が安全。**1引数の `max(x)` は集約関数になりエラー**になる
  (2引数以上はスカラー関数)
- `ON CONFLICT` の conflict target は省略できる (SQLite 3.35.0 以降) が、明示した方が安全。
  D1 の SQLite バージョンは公式に明記がない
- **`DELETE ... RETURNING` は `db.batch()` の中でも行を返す** (2026-09-14、ローカルの workerd と `wrangler dev` で確認、Issue #61)。
  `results[i].results` に消した行が入る。`INSERT ... SELECT ... WHERE ... ON CONFLICT (...) DO NOTHING` も同じ batch で通る。
  **本番の D1 では、callback ができて最初に登録するときに確かめる**
- `WITHOUT ROWID` は PRIMARY KEY 必須、PK の全カラムが暗黙に NOT NULL。
  向くのは**行が小さいとき** (目安はページサイズの 1/20、4KiB ページなら約 200 バイト)。
  それを超えると中間ノードのファンアウトが落ちて逆に遅くなる

### Workers

- URL 上限 **16 KB**。リクエストヘッダ総量 128 KB
- Worker のレスポンスは**既定ではエッジキャッシュされない**。
  [Workers Cache](https://developers.cloudflare.com/workers/cache/) を有効化すると
  `Cache-Control` が RFC 9111 どおり尊重され、ヒット時は Worker を実行せずに返る
- Worker が 304 を返すと `Cf-Cache-Status: REVALIDATED`
- Cron Triggers の最小間隔は 1 分、UTC 実行、変更の反映に最大 15 分。
  アカウントあたり Free 5 / Paid 250
- バンドル時に別ファイルを文字列として取り込むなら拡張子を `.txt` にする。
  `.js` は JS モジュールとして解釈される
  ([Wrangler Bundling](https://developers.cloudflare.com/workers/wrangler/bundling/))

### テスト

`@cloudflare/vitest-pool-workers` は **2026-08-19 に `@cloudflare/vitest-plugin` へ改名された**。
`defineWorkersConfig` は削除され、`cloudflareTest()` という Vite プラグインになった。Vitest 4.1 以降が必要。

```
npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin
```

D1 マイグレーションは `readD1Migrations()` (Node 側、プラグイン設定内) と
`applyD1Migrations()` (`cloudflare:test` から import、setup ファイル内) で適用する。
公式の動く例: [workers-sdk の d1 fixture](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-plugin-examples/d1)

### OKLCH → sRGB

`culori` は Workers 公式サポートの記述がない。使うなら tree-shakable な `culori/fn` エントリに限る。
軽量な代替は `@texel/color` (OKLCH → sRGB だけなら約 3.5 KB)。

ただし OKLCH → OKLab → linear sRGB → sRGB は CSS Color 4 の固定行列と立方根だけで 30 行程度なので、
**依存ゼロの自前実装が最も軽い**。ガモット外は彩度を二分探索で詰める。

---

### WebCrypto の ECDSA (署名の形式が最重要)

Workers の対応アルゴリズムは `RSASSA-PKCS1-v1.5` / `RSA-PSS` / `ECDSA` / `Ed25519` /
`NODE-ED25519`。ECDSA の対応カーブは workerd の実装で P-256 / P-384 / P-521 のみ
(secp256k1 は非対応)。

**ブラウザの `sign` と Workers の `verify` はどちらも r‖s 形式** (IEEE P1363)。
P-256 なら 64 バイト固定で、各 32 バイトのビッグエンディアン。DER 変換は不要。

**DER を渡すと例外ではなく静かに `false` が返る。** workerd が内部で長さをチェックし、
合わなければ空の署名として扱うため。

```cpp
if (signature.size() != rsSize * 2) {
  // The signature is the wrong size. Return an empty signature, which will be judged invalid.
  return jsg::JsArrayBuffer::create(js, 0);
}
```

「鍵が違うのか署名が壊れているのか」が区別できない最悪のモードなので、**検証前に自分で
64 バイトを確認して別のエラーにする**。

公開鍵のインポートは `importKey("raw", 65 バイトの非圧縮 SEC1, {name:"ECDSA",
namedCurve:"P-256"}, ["verify"])`。`raw` 経由は**公開鍵のみで、許可 usage は `verify` のみ**。
`algorithm.namedCurve` と鍵データの曲線が一致しないと `DOMDataError`。

Ed25519 はブラウザ普及率 88% (caniuse, 2026-09-12)。Chrome 137+ / Firefox 129+ / Safari 17.0+
で実装済みだが、約 12% が未対応なので公開提供の唯一の方式にはしない。
なお Ed25519 の `verify` は署名長が 64 バイト以外なら**例外を投げる** (ECDSA と挙動が違う)。

`extractable: false` の `CryptoKey` を IndexedDB に保存できることは Web Cryptography API
Level 2 に根拠がある。「any existing or future web storage mechanisms that support storing
serializable objects can be used to store CryptoKey objects」「It is expected that most authors
will make use of the Indexed Database API」。ただし Firefox に読み出し失敗の報告
([bug 1348279](https://bugzilla.mozilla.org/show_bug.cgi?id=1348279)) があり、
プライベートブラウジングや storage eviction 下の挙動は未検証。

**2026-09-14 に本番で往復が成立した (Chrome、#36)。** Cosense のページで動く UserScript が `generateKey` (`extractable: false`) で
鍵を作り、`CryptoKey` のまま IndexedDB に保存した。6 分後と 8 分後に IndexedDB を開き直して読み出し、`sign` した r‖s の 64 バイトを、
workerd が `importKey("raw", 65 バイト, ..., ["verify"])` した公開鍵で `verify` して通った。
- 公開鍵は `exportKey("raw")` で 65 バイト (先頭 0x04) が取れた。`extractable: false` でも公開鍵は書き出せる
- ページの再読み込みを挟んだかは記録していない
- Firefox では確かめていない

### Rate Limiting と DoS 対策 (Free 枠)

**Workers の Rate Limiting binding は 2025-09-19 に GA。**

```jsonc
{ "ratelimits": [ { "name": "MY_LIMITER", "namespace_id": "1001",
    "simple": { "limit": 100, "period": 60 } } ] }
```

`period` は **10 か 60 のみ**。カウンタは Cloudflare のロケーション単位で、公式が
「permissive, eventually consistent, and intentionally designed to not be used as an accurate
accounting system」と明言している。**キーに IP を使うのは公式が非推奨。**

**Free プランで使えるかは公式に明記がない。** plan gate の記述が見つからず、課金項目もないので
使える見込みが高いが、確証はない。実機検証が必要。

**WAF の rate limiting rules は Free で 1 ルール。** characteristics は IP のみ、period は 10 秒のみ、
mitigation timeout も 10 秒のみ、式に使えるのは Path と Verified Bot のみ。
counting expression は使えない。

**`workers.dev` では zone の WAF が効かない。** WAF は zone 単位の設定で、`workers.dev` は
自分の zone ではないため構造上適用されない (明文は見つからず、推定)。独自ドメインが必要。

**Bot Fight Mode は画像ビーコンを壊す。** 「computationally expensive challenges」は JS 実行を
要求するので `<img src>` では完了できない。WAF custom rules でバイパスもできない。OFF にする。

**`is_timed_hmac_valid_v0()`** (WAF 側で署名付き URL を検証する関数) は Pro 以上。Free では使えない。

**Workers Free は日次 10 万リクエスト。** 超過時の挙動は route 設定で選べる。
fail open は「Worker が設定されていないかのように振る舞う」、fail closed は 1027 エラーページ。
**セキュリティ上は fail closed を選ぶ。**

WAF でブロックされたリクエストは Workers に到達しないので日次枠を消費しない。
一方 binding 方式は Worker 内で動くので必ず消費する。役割が違う。

### rows written の定義 (書き込み予算に直結)

公式の定義は「Write operations include `INSERT`, `UPDATE`, and `DELETE`」。

**インデックス分は別にカウントされる。** 「Indexes will add an additional written row when writes
include the indexed column, as there are two rows written: one to the table itself, and one to
the index.」つまり**インデックス列を更新する UPSERT は 1 行で 2 rows written 以上**になる。
10 万行/日は実質 5 万更新/日になりうるので、インデックスを絞ることが予算の節約に直結する。

**no-op な UPDATE がカウントされるかは公式に記述がない。**
`ON CONFLICT DO UPDATE SET x = ? WHERE ? > x` で条件が偽のときの課金挙動は不明。
`meta.rows_written` / `meta.changes` / `meta.changed_db` がクエリ単位で取れるので、
実機で確認できる。**課金上の真実は meta ではなく翌日のアカウント集計値なので両方突き合わせる。**

上限到達時のエラーは `D1_ERROR` 系で、メッセージは
「Your account has exceeded D1's free tier daily row write limit.」**数値コードはない。**
メッセージの部分一致で分岐するのは脆いので、**エラー種別に依存せず「書き込みが throw したら
degrade」**にする。

### 認証とデプロイ (2026-09-12 調査)

複数の Cloudflare アカウントを持っていて、ログイン中のものとは別のアカウントを使う前提で調べた。

**認証情報の優先順位は公式が明記している。** 高い順に、`CLOUDFLARE_API_TOKEN` 環境変数、
`--profile` フラグ、直近の activate 済み祖先ディレクトリ、既定プロファイル。
**環境変数はすべての認証プロファイルを上書きする。**

**認証プロファイルが 2026-07-02 のリリースで追加された。** `wrangler auth create` /
`activate` / `deactivate` / `list` / `delete`。ディレクトリに束縛できる。
**ただし 4.131.1 時点でこれらはすべて `[experimental]` と表示される** (実測)。
プロファイルはローカルの利便機能で、CI には適用されない。

`wrangler login` の認証情報の置き場は、公式が `~/.config/.wrangler/config/default.toml` と
書いているが、**macOS の実体は `~/Library/Preferences/.wrangler/config/default.toml`** (実測、mode 600)。
中身は `oauth_token` / `refresh_token` / `expiration_time` / `scopes` の TOML。

**`wrangler` CLI は `.env` から `CLOUDFLARE_API_TOKEN` などを読む。** 公式が「セッション間で値が
永続するので推奨」とまで書いている。ただし**同じ `.env` はローカル開発時に Worker の `env` にも
ロードされる** (`.dev.vars` も `secrets.required` も無い場合)。秘密値は `.dev.vars` に置いて
`.env` は使わないのが安全。

**アカウントの取り違えは公式リポジトリでも未解決の議題。** 非対話で複数アカウントに属している
ときにリストの先頭を黙って選ぶ挙動が workers-sdk の issue #9001 で提起され、open のまま。
`wrangler.jsonc` の `account_id` か `CLOUDFLARE_ACCOUNT_ID` を**必ず明示する**。
両者の相互の優先順位は公式に明記がない。

**API トークンの「Edit Cloudflare Workers」テンプレートに D1 は含まれない。** 公式の一覧は
Workers Routes Write / Workers Scripts Write / Workers KV Storage Write / Workers Tail Read /
Workers R2 Storage Write / Account Settings Read / User Details Read / User Memberships Read の 8 つ。

**`wrangler d1 migrations apply --remote` には Account > D1 > Edit が必要。**
2025-05-02 の D1 リリースノートで、HTTP API 経由の書き込みに `D1:Edit` が要ると明記された
(それ以前は `D1:Read` だけで書けていた)。

**Cloudflare は GitHub Actions の OIDC によるトークンレス認証をサポートしていない。**
`wrangler-action` の要望 (#402) と workers-sdk の議論 (#11434、2025-11-26 起票) はどちらも
open のままで、Cloudflare 側の回答もロードマップもない。長命トークンを Secrets に置くしかない。

緩和策として公式にあるもの。**account-owned token** (ユーザーに紐づかない独立した権限セット)、
Account Resources で対象アカウントを限定、TTL (`expires_on`。既定では期限切れしない)、
Client IP Filtering (CIDR。ただし Verify Token エンドポイントには適用されない)。

**`wrangler d1` のフラグ省略時の既定はローカル** (実装をソースで確認)。
公式の D1 Local development ページは「`--local` なしならリモート」と書いているが**実装と逆**。
常に明示する。

`wrangler deploy --secrets-file <path>` でコードと secrets を 1 操作で投入できる。
1 version あたり 100 件まで。**ファイルに含まれない secret は前の version から引き継がれる。**
`secrets.required` を宣言していると、未設定の secret があると `deploy` が失敗して
どれが足りないかを列挙する。

**認証が不要なコマンドの範囲は公式に明言がない。** 公式に「ログイン不要」と書いた文は
見つからなかったので実測した (下記)。

### 段階 0 の実測 (2026-09-12、wrangler 4.131.1)

資格情報の置き場を見せない状態 (`HOME` を空のディレクトリに差し替えて実行) で測った。

| コマンド | 結果 |
|---|---|
| `wrangler types --check` | **通る。** 「Types at worker-configuration.d.ts are up to date.」 |
| `wrangler deploy --dry-run` | **通る。** バインディング一覧を出して終了する |
| `wrangler d1 migrations apply <db> --local` | **通る。** 「Resource location: local」と明示し、`--remote` の案内を出す |
| `vitest run` (Workers project 込み) | **通る。** 14 件すべて緑 |

**`wrangler types --check` は実在する。** バンドルされたコマンド定義に
「指定パスの型が最新かを再生成せずに検査する」とあり、`status: "stable"`。
生成物を追跡下に置いて CI で差分を見る運用が成立する。

**`wrangler dev --test-scheduled` の Cron 起動は `/__scheduled` を使う。**
ヘルプ文字列が案内するのもこれ。`/cdn-cgi/handler/scheduled` は miniflare 直の口
(legacy は `/cdn-cgi/mf/scheduled`)。

実測では**3 つの経路すべてで `scheduled` ハンドラが走った**
(`/__scheduled` / `/cdn-cgi/handler/scheduled` / `/cdn-cgi/local/scheduled`。
ハンドラ内に一時的なログを入れて、経路ごとに回数を数えて確認)。
ただし `wrangler` のソースを読むと `/cdn-cgi/local/` は R2 の public 用の名前空間で、
scheduled の口としては定義されていない。**文書化されている `/__scheduled` を使う。**
Worker のリクエストログに残るのも `/__scheduled` だけで、他の 2 つはログに出ない。

**テストストレージの分離の根拠が 1.1.8 で変わっている可能性がある。**
`WorkersPoolOptionsSchema` に `isolatedStorage` オプションが見当たらない (0.18 にはあった)。
「分離はテストファイル単位」という前提は **D1 を本格的に使う段階 3 の前に再確認する。**

**`applyD1Migrations` は文を含まない `.sql` を拒否する** (`D1_ERROR: SQL code did not contain a
statement`)。中身の無いプレースホルダのマイグレーションは置けないので、スキーマが決まるまでは
`migrations/` を空に保つ (`readD1Migrations` は `.sql` だけを拾うので、他のファイルは無害)。

**`secrets.required` は `deploy --dry-run` を壊さない。** 未設定でもバンドルの検証は通る。
ただしテスト中に「Missing required secrets」の警告が出る。**`vitest` の
`miniflare.bindings` にダミー値を置いても、この警告は消えない**
(警告は設定読み込み時のもの)。バインディング自体は効いていて、テスト内の
`env.WORKER_SECRET` はダミー値になる。

**`database_id` がプレースホルダでもローカルは動く。** miniflare はこの値をローカルの
識別子としてしか使わないので、D1 を作る前から Workers のテストとマイグレーションの
仕組みを組める。

**`cloudflare:workers` の型宣言がどこにも無い。** `cloudflare:test` の `env` と `SELF` は
JSDoc で非推奨と注記され、後継として `cloudflare:workers` からの import を案内しているが、
`wrangler types` の出力にも `@cloudflare/vitest-plugin` にもそのモジュール宣言が無い
(`cloudflare:email` / `cloudflare:pipelines` / `cloudflare:sockets` はある)。
**型が付く経路は現時点で `cloudflare:test` 側だけ。**

**`@types/node` の `latest` タグは 22 系を指す。** `npm i --save-dev @types/node` をそのまま
打つと 22 が入り、`engines.node: ">=24"` と食い違う。TypeScript の版ごとの dist-tag
(`ts6.0` など) は別に用意されている。**明示的に `^24` を指定する。**

**vitest は 5.0.0 が出ているが上げられない。** `@cloudflare/vitest-plugin@1.1.8` の peer が
`vitest: ^4.1.0` / `@vitest/runner: ^4.1.0` / `@vitest/snapshot: ^4.1.0`。
プラグインは `wrangler 4.131.1` を依存として固定しているので、wrangler も同じ版に合わせる。
輸出は `cloudflareTest` / `readD1Migrations` / `D1Migration` がルートから取れる。

### 初回デプロイの経路 (2026-09-13、wrangler 4.131.1 のソース)

**`--secrets-file` はまず JSON として読み、失敗したら dotenv として読む** (`parseBulkInputToObject`)。
dotenv は引用符を剥がし、値の中の ` #` 以降を注釈として捨てる。**一度しか決められない値は JSON で書く。**
`#`・引用符・`+/=` を混ぜたダミー値を Node の `JSON.stringify` で書き出し、化けずに往復することを確かめた。

**Worker が存在しない状態の deploy は、`secrets.required` の値が揃わないと例外になる**
(`addRequiredSecretsInheritBindings`)。

```
if (options.type === "deploy" && !options.workerExists) {
  throw new UserError(`The following required secrets have not been set: ...`)
```

2 回目以降は宣言した secret が `{ type: "inherit" }` バインディングになるので、
毎回 `--secrets-file` で渡しても害は無い。

**`workers_dev` の既定は `routes` の有無で変わる** (`getSubdomainValues`)。

```
const defaultWorkersDev = routes.length === 0;
const workers_dev = config_workers_dev ?? defaultWorkersDev;
```

`routes` を足した瞬間に workers.dev が既定で無効になる。独自ドメインへ移る前後で動作確認の場を
残したいなら明示する。

**バインディングを実アカウントと照合する検査は wrangler 側に無い。** 存在しない D1 の ID や、
プランで使えないバインディングの扱いは Cloudflare の API 側の判定で、ソースからは確かめられない。
`--dry-run` はアカウントを参照しない (`requireAuth` を通らない) ので、**`--dry-run` が通っても
本番デプロイが通る保証にならない。**

### D1 を作る経路とテスト (2026-09-14、wrangler 4.131.1・@cloudflare/vitest-plugin 1.1.8 のソース)

Issue #36 で D1 を使い始めるときに確かめた。【ソース】は実装を読んで確認、【実行】はローカルで動かして確認。

**`d1_databases` に `database_id` が無いと、`wrangler deploy` はデータベースを自動で作る**【ソース】。
`--x-provision` と `--x-auto-create` は hidden のフラグで既定が true。`database_name` があればその名前をアカウントから探して
再利用し、無ければその名前で作る。CI でもプロンプトは出ず、作った ID は設定ファイルに書き戻さない。
トークンの権限が足りない (403) と警告だけ出して飛ばす。**location hint は付かない。**

**今の CI の順序では初回で落ちる。** `d1 migrations apply <name> --remote` は、設定に ID が無ければ名前で API を引くが、
データベースが無いと「Couldn't find a D1 DB named ...」で失敗する【ソース】。マイグレーションはデプロイより前の段なので、
自動作成まで進まない。ADR-0014 決定 9 で「無ければ作る」段を前に置いた。

- **`wrangler d1 create` は冪等でない。** 同名があるとエラー 7502【ソース】。`--json` は無い。`--location` (weur / eeur / apac / oc / wnam / enam) はある
- **`wrangler d1 info <name>` は分析用の GraphQL (`d1AnalyticsAdaptiveGroups`) も叩く**【ソース】。有無の判定に使うと、
  トークンの権限次第でデータベースがあっても失敗しうる。`wrangler d1 list --json` はページングしながら一覧だけを取る
- **`database_id` が無くても `wrangler types --check` と `--dry-run` は通り、ローカルの D1 も動く**【実行・ソース】。
  ローカルは ID の代わりにバインディング名を使う。vitest も `wrangler d1 execute --local` も `wrangler dev` もこの状態で動いた

**テストの D1 はテストファイル単位で分かれ、同じファイルの中では共有される**【ソース】。vitest の `isolate` (既定 true) で
ファイルごとにランナーが作られ、そのたびに Miniflare が立つ。同じファイルのテスト同士は前のテストの中身を引き継ぐので、
テストごとに別の uid を使う。0.18 にあった `isolatedStorage` の設定は無くなっている (段階 0 の実測で気付いた点の答え)。

**マイグレーションは設定の関数形で読み、setupFiles で当てる**【実行】。

```ts
cloudflareTest(async () => ({
  wrangler: { configPath: "./wrangler.jsonc" },
  miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations("migrations") } },
}))
// setupFiles: await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
```

`env` の型は `Cloudflare.Env` なので、テスト用のバインディングは `declare namespace Cloudflare { interface Env { ... } }` で足す。

**ローカルの D1 で通った構文**【実行】。`WHERE uid = ? AND (ph, day) IN (VALUES (?, ?), ...)` (行値の IN)、
`ON CONFLICT (...) DO UPDATE SET r = max(daily.w + daily.r, excluded.w + excluded.r) - max(daily.w, excluded.w)`
(右辺の `daily.*` は更新前の値)、BLOB 同士の等値比較による条件つき UPDATE。条件に合わない UPDATE と
`ON CONFLICT DO NOTHING` の衝突は `meta.changes` が 0 になる。

**本番の D1 でも、行値の IN を含む読みの batch と、graphs の INSERT・daybits の INSERT・daily の UPSERT を含む書きの batch が通った**
(2026-09-14、#36 の記録の疎通確認で幅 17 が返った)。条件つき UPDATE の衝突 (`meta.changes` が 0) は本番では起こしていない。

**`.claude/settings.json` の deny は `wrangler d1 migrations apply` を `--local` でも止める**。ローカルでスキーマを当てるときは
`wrangler d1 execute cosense-grass --local --file migrations/0001_init.sql` を使った。

---

## 6. Google OAuth と COOP

Worker が Cosense とは独立に OpenID Connect のリライングパーティになる前提で調べた
(ADR-0011)。基準日 2026-09-12。

### 審査の要否 (確定)

> If your app utilizes only **non-sensitive** scopes, it is not mandatory for your app to complete
> the app verification process.

`openid` / `email` / `profile` は non-sensitive。**`openid` のみなら審査は不要。**

- **「このアプリは確認されていません」の警告が出るのは sensitive / restricted スコープのとき**だけ
- **100 ユーザー上限も sensitive / restricted 限定。** 非機密スコープならかからない
- 同意画面にアプリ名とロゴを出したいなら brand verification が別途必要。必須ではない

出典: [OAuth App Verification](https://support.google.com/cloud/answer/13463073),
[Unverified apps](https://support.google.com/cloud/answer/7454865),
[FAQ](https://support.google.com/cloud/answer/13463817)

### ポリシー URL (不明が残る)

[App Branding](https://support.google.com/cloud/answer/15549049) に
「**These links are required for all external production apps.** You will not be able to submit your
app for verification if it is missing these links.」とある。

ただし根拠文が「verification に submit できない」なので、**審査に出さない non-sensitive アプリが
ポリシー URL 未設定で publish できるかは読み取れない。** 実機検証が必要。

Testing モードには例外がある。「The only exception to this behavior is if your app requests a
subset of the following: name, email address, and user profile」の場合、テストユーザー登録が
不要で警告も出ず、7 日で失効もしない。

### `sub` は public subject type (設計への影響大)

discovery document (`https://accounts.google.com/.well-known/openid-configuration`) の実測値。

```
subject_types_supported: ["public"]
issuer: "https://accounts.google.com"
jwks_uri: "https://www.googleapis.com/oauth2/v3/certs"
id_token_signing_alg_values_supported: ["RS256"]
code_challenge_methods_supported: ["plain", "S256"]
```

`public` なので、**`sub` はアプリごとに異なる値ではなく、同じ Google アカウントなら全 OAuth
クライアントで同じ値**。公式も「unique among all Google Accounts and never reused」と書いている。

つまり素の `SHA-256(sub)` は、同じハッシュ関数を使う他サービスのデータと突合できる
グローバル識別子になる。**アプリ固有の秘密で HMAC する必要がある。**

### ID トークンの検証

- `iss` は **`https://accounts.google.com` と `accounts.google.com` の両方を許容する**。
  スキームなしも正当で、自前実装でよく落ちる
- `aud` がクライアント ID、`exp` が未来、`nonce` が一致することを確認する
- `alg` は RS256 のみ受け入れる (`none` / HS256 の混入を弾く)。`kid` でキーを引く
- `tokeninfo` エンドポイントは**デバッグ専用**。「For production purposes, retrieve Google's public
  keys from the keys endpoint and perform the validation locally」
- JWKS の実測 (2026-09-12): `cache-control: public, max-age=23651, must-revalidate` で約 6.6 時間、
  常に 2 本 (ローテーション中の新旧)。**未知の `kid` が来たらキャッシュを無視して 1 回だけ
  再取得する**経路を用意する

Workers は `RSASSA-PKCS1-v1_5` に対応しているので JWT を検証できる。Google の JWK は `n` / `e`
だけで SPKI 変換は不要。`importKey("jwk", ...)` に `alg` / `use` / `key_ops` を含めたまま渡すと
整合でエラーになる可能性があるので、`{kty, n, e}` だけ抜いて渡すのが無難 (未検証)。

### CSP は postMessage を妨げない (確定)

CSP Level 3 のディレクティブ一覧に**ウィンドウ間メッセージングを管轄するものは存在しない**。
CSP が検査するのはリソース取得 (fetch directives)、ナビゲーション (`form-action`,
`frame-ancestors`)、ドキュメント設定 (`base-uri`, `sandbox`) で、`postMessage` はどれにも属さない。
MDN の `Window.postMessage()` のセキュリティ節も防御機構として `targetOrigin` だけを挙げ、
CSP に言及していない。

**`window.open` も CSP では制限されない。** それを行うはずだった `navigate-to` ディレクティブは
**2022 年 9 月に CSP 仕様から削除され、どのブラウザにも出荷されなかった**。
`form-action 'self'` は form の submit のみを制限するので `window.open` には無関係。

### COOP の実測値 (2026-09-12)

**scrapbox.io はパスによって違う。**

| パス | COOP |
|---|---|
| `https://scrapbox.io/` | `same-origin` (opener が切れる) |
| `https://scrapbox.io/help-jp` | `unsafe-none` |
| `https://scrapbox.io/help-jp/Scrapbox` | `unsafe-none` |
| `https://scrapbox.io/villagepump/雑談` | `unsafe-none` |

**UserScript が動くのはプロジェクトページなので `unsafe-none`。** 親側で opener が切れる条件には
該当しない。ルート `/` だけ `same-origin` なのは後から強化したためと見られる。

**Google のサインイン画面は report-only。**

| ドキュメント | COOP |
|---|---|
| `accounts.google.com/o/oauth2/v2/auth` (302) | `cross-origin-opener-policy-report-only: same-origin` |
| `accounts.google.com/v3/signin/identifier` (実際の画面) | `cross-origin-opener-policy-report-only: same-origin` |
| `accounts.google.com/signin/oauth/error` | `cross-origin-opener-policy: same-origin` (enforced) |

report-only は強制しないので `window.opener` は維持される。
**ただし `report-to` が設定されているのは移行準備の典型で、enforced に切り替わるリスクがある。**
Bluesky は 2025 年 3 月に実際に壊れた (`popup.closed` が常に `true`、`popup.opener` が `null`)。

Worker 側のポップアップ用レスポンスには **COOP を付けない** (`unsafe-none`)。
`same-origin` を付けると opener が切れて設計が崩壊する。
`same-origin-allow-popups` は「開く側」のための緩和なので、開かれる側の Worker には効かない。

**`popup.closed` のポーリングに依存しない。** COOP 下では嘘をつく。
`postMessage` の受信をタイムアウト付きで待つ。

### ポップアップブロッカー

`window.open` は **transient activation** を必要とする。「within five seconds of user interaction」
で、`await` を挟むと失われる可能性が高い。

実装は **click ハンドラの同期的な先頭で `window.open('/auth/start', ...)` を呼び、
URL 構築とリダイレクトは Worker 側でやる**のが一番堅い。
`navigator.userActivation.isActive` で事前チェックもできる。

### state / nonce / PKCE の保持

**署名付き cookie が最も素直。** `HttpOnly; Secure; SameSite=Lax; Path=/auth; Max-Age=600`。
Google からの復帰は top-level GET navigation なので `SameSite=Lax` でも送られる
(`None` は不要で、その方が安全)。

**KV は state には使わない。** eventual consistency で、書いた直後の読み取りが別のロケーションで
miss しうる。OAuth の往復はまさにその時間スケール。

PKCE は Google が `S256` に対応している。Worker は client secret を持てるので必須ではないが、
認可コード横取り対策として付ける。

### クエリ文字列の正規化

`URLSearchParams.toString()` を署名対象にしてはいけない。AWS SigV4 が `UriEncode` を自前で
書くよう推奨しているのと同じ理由で、「standard UriEncode functions provided by your development
platform might not work because of differences in implementation」。
空白が `+` になる、エンコード集合が違う、順序が実装依存、重複キーの扱いが不定。

本プロジェクトは固定順・固定フィールドの改行区切りにするので、SigV4 のような汎用の正規化は不要。

### Cosense の認証プロバイダ

`/api/users/me` の `provider` は `"google" | "microsoft" | "email"`。

**非 Google 認証は有料のビジネス版限定で、かつ申込制。**
[プレスリリース](https://prtimes.jp/main/html/rd/p/000000059.000027275.html) (2021-01-07) に
「ビジネス版にて、Googleアカウント以外のログイン認証方法が設定できるようになりました」
「ご利用にはお申し込みが必要です」とある。SAML 認証もビジネス版向け。

**無料プランと個人利用の Cosense ユーザーは Google アカウントでしかログインできない。**
Google のみの対応で実質的な取りこぼしはない。

参考: GitHub OAuth は審査もポリシー URL も不要で要件が最も軽い。
Microsoft は `openid profile` のみなら publisher verification は不要と推定されるが、
必要になった場合は Partner Program のアカウントが要るのでハードルが高い。

---

## 7. まだ確認できていないこと

実装の前に潰すもの。どれも設計の前提になっている。

- **ECDSA P-256 のラウンドトリップ。** 2026-09-14 に Chrome で成立した (§5 の WebCrypto の節、#36)。Chrome 以外は未確認
- **`importKey("jwk", ...)` に Google の JWK をそのまま渡して通るか。** `alg` / `use` / `key_ops` の
  整合でエラーになる可能性がある。**実装は `{kty, n, e}` だけを渡す形にした** (2026-09-14、Issue #61)。
  WebCrypto で作った RSA 鍵を Google と同じ形の JWK にして、workerd で読み込めることはテストで確かめた。
  **Google が実際に配る JWKS ではまだ試していない** (callback の実装で確かめる)
- **ポップアップから `window.opener.postMessage` が scrapbox.io のプロジェクトページに届くか。**
  COOP の実測値からは通るはずだが、設計の根幹なので確認する
- **ポリシー URL 未設定のまま non-sensitive スコープのアプリを publish できるか。**
  Google Cloud Console の Branding を空欄にして Audience の Publish app が押せるか
- **Rate Limiting binding が Free プランで使えるか。** 公式に plan gate の記述がない
- **no-op な UPDATE が rows written にカウントされるか。** `meta.rows_written` と翌日の
  アカウント集計値の両方を突き合わせる
- **`extractable: false` の `CryptoKey` を IndexedDB から読み戻せるか。** **Chrome では読み戻して署名できた** (2026-09-14、#36)。
  Firefox に読み出し失敗の報告があり、そちらは未確認
- **配布モジュールが 1 ドキュメントで 1 回しか評価されないか** (§2 の常駐)。import の 1 行が無いプロジェクトへアプリ内で移ったとき、
  センサーが止まらずに動き続けることで確かめる (段階 5、#49)
- **プレースホルダーの `scrapbox.Page.id` が保存の前後で変わらないか。** REST の `/api/pages/v2/:project/:title` の `user` が
  作成者で、`created` が初回保存の時刻か。新規作成の数え方 (段階 5) の前提
- **元に戻す / やり直しで `by` が `undefined` になるか。別のタブでの自分の編集が `remote` で届くか** (§2 の `window.scrapbox` API)

設計に影響しないが残っているもの。

- `/api/commits` の保持期間がプランに依存するか (personal プランでのみ実測)
- `/api/commits` のレート制限
- ページリネーム時の一括リンク更新がどのユーザーの commit として記録されるか
- `page-edit-for-ai` が Cookie + `X-CSRF-TOKEN` でも通るか (CLI は PAT ヘッダのみ送っている)
- `[[ ]]` 記法とクエリ付き URL の組み合わせの実挙動 (`[ ]` を使うので回避している)
- brand verification をせずに production で公開した場合、同意画面に実際に何が表示されるか
