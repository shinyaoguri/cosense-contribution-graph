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

### SHA1 承認ゲート

本体が script.js を fetch して SHA1 を計算し、localStorage の `userScriptSHA1[projectId]` と比較する。
不一致なら**タグを注入せず**、「新しいUserScriptを読み込む」バナーを出す。

つまり **`code:script.js` の中身を書き換えるたび、リロード後に手動承認が1回必要**。
逆に言えば、script.js を1行の `import` に固定しておけば、import 先を更新しても承認は要らない。
これが「配布ページを別に置く」方式の実務上の利点。

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

## 6. まだ確認できていないこと

- `/api/commits` の保持期間がプランに依存するか (personal プランでのみ実測)
- `/api/commits` のレート制限
- ページリネーム時の一括リンク更新がどのユーザーの commit として記録されるか
- `page-edit-for-ai` が Cookie + `X-CSRF-TOKEN` でも通るか (CLI は PAT ヘッダのみ送っている)
- `[[ ]]` 記法とクエリ付き URL の組み合わせの実挙動 (`[ ]` を使うので回避している)
