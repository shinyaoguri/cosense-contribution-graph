# 設計

Cosense (旧 Scrapbox) の活動を GitHub のコントリビューショングラフのように可視化する。
成果物は UserScript と Cloudflare Worker + D1 の2つ。

前提となる実測事実は `research.md`、設計判断とその理由は `decisions/` にある。
**この文書を読む前に `decisions/` の ADR-0001 / ADR-0002 / ADR-0011 を読むこと。**
送信経路、指標の持ち方、身元の紐づけ方が素朴な設計と違う理由がそこにある。

---

## 1. ゴールと非ゴール

### ゴール

- Cosense ユーザーが `code:script.js` に1行書くだけで導入できる
- 「書いた」だけでなく「読んだ」活動も記録する
- 活動量を濃さ、読み書きのバランスを色相で表す2次元の草
- 複数プロジェクトを使っている人が、全体を集約した草とプロジェクトごとの草の両方を見られる
- **複数のデバイスから使っても 1 つの草に統合される**
- 共有可能な静的 SVG URL を発行する
- サーバに個人情報を置かない。プロジェクト名も Google アカウントも復元できない形にする

### 非ゴール

- プロジェクト内のランキングや競争機能。読みも書きも自己申告で検証手段がない
- ページ内容の記録・分析
- リアルタイム性。共有 SVG は数時間の遅延を許容する
- **導入前の活動の遡り。** `/api/commits` は約 30 日で消えるので費用対効果が合わない (ADR-0012)

### 運用モデル

**作者が 1 つホストして公開提供する。** 利用者は自分で何もデプロイしない。
この前提が脅威モデルと D1 の予算を決めている (ADR-0008)。

---

## 2. アーキテクチャ

```
[scrapbox.io のページ内 / UserScript]
  センサー  20 秒ごとに localStorage のビットマップへ bit を立てる
  送信      ロード時・日付変更・タブを隠したとき・登録直後・「今すぐ送る」に new Image().src で GET
  表示      統合された記録 (共有 SVG を img で埋め込む)。**草は描かない** (ADR-0019)
  設定      Google サインイン、デバイス一覧、共有 URL、read 計上の on/off
                    │
                    ├─ ポップアップ + postMessage で Google サインイン
                    ▼ GET /v1/p.gif?...
         [Cloudflare Worker] ─── [D1]
                    │
                    ▼ GET /v1/g/{publicId}.svg
         Cosense の任意ページに [URL] で貼れる
```

送信が GET なのは CSP の制約 (ADR-0001)。ビーコンの受信方向は使えないので、DOM 注入の草は
ローカルのデータから描く (ADR-0003)。サインインだけはポップアップを使うので双方向になる (ADR-0011)。

### リポジトリ構成

```
wrangler.jsonc              Worker + D1 + Cron (Rate Limiting は Free プランで使えるか未確認のため足していない)
vitest.config.ts            projects を列挙する薄い root
vitest.worker.config.ts     @cloudflare/vitest-plugin (workerd)
vitest.userscript.config.ts environment: jsdom
vitest.scripts.config.ts    environment: node (scripts/ の手元コマンドのテスト)
migrations/                 D1 のマイグレーション (0001_init.sql から連番)
src/shared/                 Worker と UserScript の両方から import する
  ids.ts                    uid / kid / ph / publicId / dataKey の形と導出
  hash.ts                   SHA-256 の 16 進 (導出に使う。workerd にもブラウザにもある crypto.subtle だけで書く)
  base64url.ts              パディングなしの base64url。デコードは正規形だけを受け付ける
  bits.ts                   ビットマップ: OR / andNot / popcount
  sign.ts                   署名対象の正規化と ECDSA P-256 の署名・検証
  beacon.ts                 GET /v1/p.gif のクエリの組み立てと厳密な読み取り、応答の幅
  enroll.ts                 GET /v1/enroll.gif のクエリの組み立てと厳密な読み取り、応答の幅
  revoke.ts                 GET /v1/revoke.gif (この端末の失効) のクエリの組み立てと厳密な読み取り
  auth.ts                   サインインのコード (uid と登録トークンの 48 文字) の組み立てと読み取り
  epoch-day.ts              YYYY-MM-DD と通し日数の変換 (UTC だけで計算する)
  grass-icon.ts             草のマス目 3×3 のアイコン。UserScript のボタンと Worker の favicon が同じ絵を使う
  probe.ts                  GET /v1/probe.gif (送信の疎通確認) の取り決め。使うのは Worker だけ
  project-name.ts           Cosense のプロジェクト名の形 (半角英数とハイフン。research §2)
  guide.ts                  草のダイアログの説明に添える図の名前と寸法 (描くのは Worker。Issue #182)
  links.ts                  人が開くページへのリンク (ポリシー・配布ページ・リポジトリ)。トップとダイアログが共用
src/worker/
  index.ts                  ルーティング
  auth.ts                   /auth/start と /auth/callback
  auth-cookie.ts            サインインの往復のあいだ state・nonce・code_verifier を持つ署名付き cookie
  auth-page.ts              callback がポップアップに返す HTML (postMessage とコードの表示)
  idtoken.ts                Google の ID トークンの検証と JWKS の保持
  uid.ts                    sub から uid を導く (HMAC)
  enroll.ts                 デバイスの登録 (GET /v1/enroll.gif) と登録トークンの発行。失効 (GET /v1/revoke.gif)
  responses.ts              画像ビーコンの受け口が返す透過 GIF と拒否
  ingest.ts                 GET /v1/p.gif
  merge.ts                  受け取ったエントリと保存済みの値のマージ (純関数)
  days.ts                   記録を受け付ける日付の窓と、ビットマップの保持日数
  keys.ts                   署名の検証に使う公開鍵を keys テーブルから引く
  probe.ts                  GET /v1/probe.gif。送信の疎通確認 (記録しない。D1 も認証も使わない)
  params.ts                 描画パラメータをクエリから読む (不正な値は既定に落とす)
  graph-data.ts             共有グラフを D1 の記録から描く (publicId を引いて、草と概観の入力を作る)
  svg.ts                    GET /v1/g/{publicId}.svg。graph/layout.ts のレイアウトを文字列にする
  overview-svg.ts           GET /v1/g/{publicId}/overview.svg。graph/overview.ts のレイアウトを文字列にする (ADR-0021)
  json.ts                   GET /v1/g/{publicId}/{dataKey}.json。日ごとの集計値 (ADR-0020)
  demo.ts                   デモの草 (publicId = demo)。実データを持たず、決定論的に作る
  cron.ts                   古いビットマップの削除
  account.ts                /account の一覧・失効・共有 URL・全削除 (ADR-0017・0018)
  session.ts                サインイン済みを 30 分覚える cookie (ADR-0017)
  site.ts                   / と /privacy (英語)、/ja と /ja/privacy (日本語) (ADR-0018・0022)
  favicon.ts                /favicon.svg (Cosense のボタンと同じ絵。Issue #130)
  guide-svg.ts              /v1/guide/{name}.svg (草のダイアログの説明に添える図。Issue #182)
  markdown.ts               privacy.md・privacy.en.md を HTML にする部分集合の変換
  md.d.ts                   `*.md` を Text モジュールとして import するための型
  privacy-source.ts         privacy.md を Text モジュールとして読み込めることの確認 (test/worker/md-probe.test.ts だけが使う)
  graph/                    草を描く一式。**Worker だけが持つ** (ADR-0019、Issue #110)
    layout.ts               草の寸法・色・ラベルの位置。SVG の文字列にも DOM にもしない
    overview.ts             活動の概観 (4 軸のレーダー) の寸法・色・ラベルの位置 (ADR-0021)
    grid.ts                 53 週グリッドの格子と描画パラメータ
    scale.ts                四分位スケール
    balance.ts              読み書きのバランス (配色に依らない)
    scheme.ts               配色の差し替え口と登録表 (§7)
    schemes/                配色。bands.ts が「表で色を指定するスキーム」を作り、violet-amber.ts が表を持つ (ADR-0023)
src/userscript/
  index.ts                  エントリ。常駐とマウント
  sensor.ts                 20 秒ポーリングと lines:changed。数えるプロジェクトの判定
  time.ts                   ローカル時刻の日と分
  image.ts                  画像 GET で Worker に送る (Cosense の CSP で fetch も sendBeacon も使えない。ADR-0001)
  outbox.ts                 送る記録を選び、送信済みをダイジェストで覚える (段階 6)
  sender.ts                 登録した鍵で署名して送る。きっかけ・ロック・失敗の抑制 (段階 6)
  keys.ts                   この端末の鍵と uid を IndexedDB に 1 レコードで持つ
  revoke.ts                 この端末の失効 (署名して /v1/revoke.gif を送り、ローカルの鍵も消す)
  cleaner.ts                このブラウザの記録を消す (localStorage の記録だけ。ADR-0018)
  auth.ts                   サインインのポップアップ、postMessage とコードの貼り付けの受信、登録
  sign-in-dialog.ts         サインインのダイアログ (段階 8 の設定 UI までの仮の置き場)
  worker-origin.ts          Worker のオリジン (https://grass.soui.dev) と、草・概観・カード・JSON の URL、Cosense に貼るカードの行。publicId の導き方 (graphIds)
  profile.ts                プロフィールページにカードの行を貼り続ける (ADR-0025)。足す位置・commit とメタデータの組み立て・読み直し
  cosense-socket.ts         Cosense 本体と同じ WebSocket で commit を 1 つ送る。Engine.IO v4 / socket.io v5 の最小限 (ADR-0025)
  menu-icon.ts              ページメニューのボタンのアイコン (data: URI の SVG。Issue #122)
  dialog.ts                 背景のクリックで <dialog> を閉じる。草のダイアログと設定のダイアログが使う
  store.ts                  localStorage (直近 30 日のビットマップ。ADR-0019)
  viewer.ts                 草のダイアログに並べる草を決める (段階 8)
  graph-dialog.ts           草のダイアログ。全端末を統合した草を img で並べる。「設定」への導線もここ
  settings.ts               「設定」に何を出すかを決める (段階 8)
  settings-dialog.ts        「設定」のダイアログ (段階 8)
  settings-store.ts         localStorage (設定)
scripts/                    手元と CI で走らせるコマンド
  build-userscript.mjs      esbuild でバンドルする (配布ページへの反映は paste-distribution.ts。ADR-0013 決定 3)
  paste-distribution.ts     配布ページへバンドルを貼る (手元の cosense CLI。CI では走らせない)
  check-distribution.sh     配布ページの script.js が手元のバンドルと一致するか (SHA-256)
  check-links.sh            Markdown の相対リンクと ADR の索引の検査
  check-pr-title.sh         PR タイトルの Conventional Commits 検査
  oauth-logo.ts             OAuth 同意画面のロゴ PNG を作る (コミットしない)
  readme-images.ts          README の画像を Worker の絵から作って Gyazo へ上げ、台帳を書き戻す
```

`shared/` に置くのは**両端が同じ文字列・同じ値を作ることが前提のもの**だけ (署名の正規化・ビーコンの
取り決め・識別子・日付・アイコンの絵)。**片側しか使わないものを置かない** — esbuild の tree-shaking は
トップレベルの関数呼び出しや二項演算を落とさないので、shared に置いた Worker 専用のコードは
未参照のまま利用者のブラウザへ配られる (ADR-0019 の 2026-09-16 の改訂、research §6)。
`scripts/build-userscript.mjs` が `src/worker/` の混入をビルドで止める。
UserScript は esbuild で単一ファイルにバンドルする。

### 複数プロジェクトの扱い

UserScript は**プロジェクトごとに置く必要がある**。Cosense は
`/api/code/{project}/{自分のユーザー名}/script.js` しか読まないため、仕様で回避できない。

記録したくないプロジェクトには 1 行を書かなければよい。除外の設定項目は作らない。

---

## 3. 識別と認証

### 全体像

| | 役割 |
|---|---|
| Google サインイン | **誰の草かを決める。** 同じ Google アカウントなら同じ草になる |
| デバイスごとの鍵ペア | **書き込み権。** 秘密鍵はそのデバイスから出ない |

サインインは初回とデバイス追加のときだけ。日々の送信は署名で認証する。

```
uid        HMAC-SHA256(WORKER_SECRET, "google:" + sub) の先頭 160 bit を base64url (27 文字)
                                                         サーバ主キー。外に出さない
kid        SHA-256(公開鍵)[0:16]                          デバイス識別子
ph         SHA-256(uid + ":" + プロジェクト名)[0:16]       プロジェクト識別子。'*' は全体
publicId   SHA-256(uid + ":*")[0:32]                     全体の共有 URL
publicId_p SHA-256(uid + ":" + ph)[0:32]                 プロジェクトの共有 URL
dataKey    SHA-256("data:" + uid + ":" + ph)[0:32]       日ごとの集計値の JSON の鍵。publicId と並べる (ADR-0020)
```

### `sub` は Worker 固有の秘密で HMAC する

Google の `subject_types_supported` は `public` なので、**`sub` は同じ Google アカウントなら
全 OAuth クライアントで同じ値**。素の `SHA-256(sub)` を使うと、同じハッシュ関数を使う他サービスの
データと突合できるグローバル識別子になる。

必ず `HMAC-SHA256(WORKER_SECRET, "google:" + sub)` にする。`sub` そのものは保存しない。

**HMAC の鍵は `WORKER_SECRET` の文字列を UTF-8 にしたバイト列そのもの** (2026-09-14、`src/worker/uid.ts`、Issue #61)。
`openssl rand -hex 32` で作った値でも 16 進としてデコードせず、64 文字の文字列として使う。
**この取り決めを変えると全員の uid が変わる**ので、既知の答えのテストで固定した。

**`WORKER_SECRET` を失うと全ユーザーの uid が再計算できなくなる。** Wrangler Secrets に置き、
必ずバックアップする。

### `ph` も uid でソルトする

ソルトなしのハッシュだと、既知のプロジェクト名の辞書でサーバ側の値を逆引きできる。
uid を知らなければ逆引きできない形にする。uid は第三者に計算できないので、
**共有 URL も第三者には導出できない**。

### サインインのフロー

CSP は `postMessage` を妨げず、`window.open` も制限しない。scrapbox.io のプロジェクトページの
COOP は `unsafe-none` なので opener が切れない (`research.md` §7)。

1. 設定 UI の「Google でサインイン」ボタン。**click ハンドラの同期的な先頭で
   `window.open("https://<worker>/auth/start", "kusa-auth", "width=480,height=640")`** を呼ぶ。
   transient activation を失わないよう、URL 構築とリダイレクトは Worker 側でやる
2. Worker が state / nonce / PKCE を生成し、**署名付き cookie** に入れて Google へ 302。
   Google からの復帰は top-level GET navigation なので `SameSite=Lax` で届く。
   **KV は使わない。** eventual consistency が OAuth の往復時間と衝突する
3. コールバックが code を交換し、ID トークンを検証する
4. `uid` を計算し、5 分有効で 1 回使い捨ての登録トークンを発行する
5. ポップアップが `window.opener.postMessage({uid, token}, "https://scrapbox.io")` を送り、
   **同じ値をコードとして画面にも表示する**
6. 親の UserScript が受け取り、鍵ペアを生成して公開鍵を登録する

2 台目も同じフロー。**同じ Google アカウントでサインインすれば同じ uid になり、自動的に同じ草へ
合流する。** 全端末を失っても同じなので、復旧コードは要らない。

**Worker 側 (手順 2〜5) を実装した** (2026-09-14、`src/worker/auth.ts`、Issue #61)。上の手順から変えた・決めたところ。

- **cookie は `__Host-grass-auth=…; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax`。** 当初の `Path=/auth` から変えた。
  `__Host-` は `Domain` を付けられないので、`soui.dev` の別のサブドメインから cookie を差し込めない。署名付きでも、
  攻撃者が自分で `/auth/start` を開いて得た正規の cookie を被害者に持たせれば、被害者の端末を攻撃者の uid に登録させられる (ログイン CSRF)
- cookie の中身は `ver | issuedAt | state(16) | nonce(16) | code_verifier(32)` の 69 バイトと HMAC。**HMAC の鍵は
  `HMAC(WORKER_SECRET, "cosense-grass:auth-cookie:v1")` で、uid の導出と用途を分ける。** 暗号化はしない (乱数だけで、
  code_verifier が読めてもトークンの交換には client secret が要る)。期限はサーバでも見る
- start は `prompt=select_account` を付ける (違うアカウントの草に合流すると戻しにくい)。**302 に `Referrer-Policy: no-referrer`**
  (scrapbox.io のページの URL を Google に渡さない)。戻り先のパラメータは持たない
- **redirect_uri は `PUBLIC_ORIGIN` (`https://grass.soui.dev`) から作る。** 別のホストの start は `PUBLIC_ORIGIN` の start へ 302、
  別のホストの callback は 404 (postMessage の送り元を 1 つに揃える)
- **手順 5 のメッセージは `{type: "cosense-grass:auth", v: 1, code}`** (失敗は `{type, v: 1, error: "cancelled" | "expired" | "failed"}`)。
  `{uid, token}` から変えた。postMessage の値と手で貼られたコードを `src/shared/auth.ts` の `parseAuthCode` 1 本で読むため。
  失敗も送るので、取り消したときに親がタイムアウトまで待たない

**UserScript 側 (手順 1・6) も実装した** (2026-09-15、`src/userscript/auth.ts`、Issue #61)。

- ページメニューの「cosense-grass」→「設定」→「サインインしてこの端末を登録」から始める (2026-09-15、Issue #79・#101。
  それまでは「草: サインインしてこの端末を登録」の単独メニューだった)。**押した同期区間で**
  `window.open(".../auth/start", "cosense-grass-auth", "popup,width=480,height=640")` を呼び、同じ区間で `message` のリスナーを付ける
  (Cosense のページメニューはクリックの処理中に `onClick` を呼ぶ。research §2)
- `message` は **`origin === "https://grass.soui.dev"` と `source === popup`** を確かめ、`type` と `v` を見てから `parseAuthCode` に渡す。
  **最初に取れたコードで締める** (同じコードの 2 回目は Worker が 403 にする)。受け取ったらポップアップを閉じる
- コードを受け取ってから保存済みの鍵を読む。**同じ uid なら使い回し** (署名できなければ新しい鍵)、無ければ作る、
  **別の uid なら確かめてから置き換える**。登録する鍵で署名して `/v1/enroll.gif` を送り、**16 / 17 が返ってから保存する**
- 結果には「新しく登録した / 登録済み」、受け取った経路、kid、合算の草の URL を出す。**uid・コード・トークンはログにも画面にも出さない**

### COOP が enforced になったときのフォールバック

Google のサインイン画面の COOP は現在 report-only だが、`report-to` が設定されているのは
移行準備の典型で、**enforced に切り替わると `window.opener` が `null` になり postMessage が壊れる**。
Bluesky が 2025 年 3 月に実際に壊れた。scrapbox.io 側がプロジェクトページの COOP をルートと
揃える可能性もある。

代替手段が乏しいので最初から備える。

- ポップアップは postMessage を送ったうえで**コードも画面に表示する**。
  `<uid>:<登録トークン>` を base64url にした **48 文字** (uid 20 バイト + トークン 16 バイト。2026-09-14、Issue #61)。
  組み立てと読み取りは `src/shared/auth.ts`。読むときは前後の空白を落とす
- ~~親は**タイムアウト付きで postMessage を待つ**。来なければ「ポップアップのコードを貼ってください」
  と案内する~~ **親はダイアログに最初から貼り付け欄を出し、postMessage と貼り付けの早い方で進む** (2026-09-15、Issue #61)。
  タイムアウトで切り替えないので、待たされる時間が無い。`window.prompt` は開いている間イベントループを止め、
  ポップアップからのメッセージを待たされるので使わない。ポップアップがブロックされた (`window.open` が null) ときはリスナーを付けない
- **`popup.closed` のポーリングに依存しない。** COOP 下では `closed` が常に `true` を返して嘘をつく
- ~~起動時に `window.opener` の生存を確認し、切れていたら明示的にフォールバックへ~~ Worker の画面は opener の有無によらず常にコードを出すので、確認は要らない

### ID トークンの検証

- `iss` は `https://accounts.google.com` と `accounts.google.com` の**両方を許容する**。
  自前実装でよく落ちる箇所
- `aud` がクライアント ID、`exp` が未来、`nonce` が一致することを確認する
- **`alg` は RS256 のみ受け入れる。** `none` や HS256 の混入を弾く
- JWKS は `https://www.googleapis.com/oauth2/v3/certs` から取り、`Cache-Control` に従って
  キャッシュする (実測で約 6.6 時間、常に 2 本)。**未知の `kid` が来たら 1 回だけ強制再取得する**
  経路を用意する
- `tokeninfo` エンドポイントはデバッグ専用。本番では使わない

**実装で決めた細部** (2026-09-14、`src/worker/idtoken.ts`、Issue #61)。

- **順序は「署名が通るまでクレームを信用しない」。** 形 → `alg` → `kid` で鍵 → 署名 → クレーム。
  `alg` で落ちたら JWKS を取りに行かない
- `aud` は**文字列で**一致すること。配列の形は、値が含まれていても拒否する (Google の ID トークンは文字列なので厳しい側に倒す)。
  `azp` があればクライアント ID と一致すること
- **`exp` と `iat` で許す時計のずれは 60 秒。** ID トークンは callback が Google から直接受け取った直後に検証するので小さくてよい。
  `iat` が 60 秒より未来なら拒否する
- `sub` は 1〜255 文字の文字列。トークンは 8KB を超えたらデコードしない
- **JWKS は isolate の中で、読み込み済みの `CryptoKey` と期限だけを持つ。** 期限は `max-age` から `Age` を引き、60 秒〜1 日に丸める
  (`max-age` が無ければ 60 秒)。取得中の Promise はリクエストをまたいで共有しない (workerd では別のリクエストの I/O を待てない)
- **未知の `kid` での取り直しは、前回の取得から 60 秒経っていればだけ。** 偽の kid を並べて Google への取得を連発させない
- `importKey("jwk")` には `{kty, n, e}` だけを渡す。`use` が `sig` 以外、`alg` が RS256 以外の鍵は使わない。
  **JWKS が取れない・使える鍵が無いときは例外** (callback が 500 にする)

### デバイスの鍵

ECDSA P-256。ブラウザの `sign` と Workers の `verify` はどちらも r‖s 形式 (64 バイト固定) なので
DER 変換は不要。**DER を渡すと例外ではなく静かに `false` が返るので、検証前に自分で 64 バイトを
確認し、別のエラーとして扱う。**

公開鍵は `importKey("raw", 65 バイトの非圧縮 SEC1, {name:"ECDSA", namedCurve:"P-256"}, ["verify"])`
でインポートする。**公開鍵のみ、usage は `verify` のみ**という制約がある。

秘密鍵は **`extractable: false` で生成して IndexedDB に `CryptoKey` として保存する。**
エクスポートしないので XSS でも持ち出せない。仕様上 `CryptoKey` は structured clone の対象で、
キーマテリアルを JS に露出させずに保存・再取得・署名できる。

Firefox に読み出し失敗の報告があるので、**読めなかったらサインインし直して再登録する**経路を
必ず用意する。鍵を失っても草は失われない。

Ed25519 はブラウザ普及率 88% なので単独採用しない。

### 署名対象は自前で正規化する

**`URLSearchParams.toString()` を署名対象にしてはいけない。** 空白が `+` になる、エンコード集合が
実装で違う、順序が不定、重複キーの扱いが未定義。

固定順・固定フィールドの改行区切りにする。**先頭の行は経路** (2026-09-14 改訂、ADR-0009)。

```
署名対象 = "/v1/p.gif\nv=1\nu=<uid>\nd=<kid>\nt=<unix秒>\np=<p の生の値>"
```

値は生のまま連結し、URL に乗せるときだけエンコードする。正規化は `src/shared/sign.ts` に置いて
両端で同じコードを使う。重複キーは Worker 側で検出して 400 を返す。

- **経路を入れるのは、署名を別の受け口に使い回させないため。** 当初の形には無く、`/v1/p.gif` の署名を
  同じフィールドを持つ `/v1/revoke.gif` や `/v1/delete.gif` へ持ち込めた
- **値に改行を含めない。** 受け口は値の形を先に正規表現で確かめ、`sign.ts` も改行を含む値を例外にする。
  改行が入ると別のフィールドを偽造できる
- **base64url は正規形だけを受け付ける。** 末尾の余りビットだけが違う別の文字列を通すと、1 つの uid や署名に
  複数の表記ができる。`atob` は余りビットを見ないので自前でデコードする (`src/shared/base64url.ts`)

`t` はリプレイ窓の制限で、サーバ時刻 ±5 分を超えたら拒否する。ビットマップは OR なので
リプレイ自体は無害だが、ログから拾った URL の再送を防げる。

### 必ず守ること

- **秘密鍵をネットワークに出さない。** 署名だけを送る
- **`sub` を保存しない。** HMAC の結果だけを持つ
- **鍵を Cosense に置かない。** 公開・非公開を問わず。読める人に書き込み権が渡る
- **UserScript にシークレットを埋め込まない。** UserScript はユーザーページに書かれ、
  公開プロジェクトなら全インターネットから読める。配布するコードは完全に公開前提で書く

---

## 4. 指標の定義

### 原子単位は「分」

コミット数は使わない。Cosense のコミットは改行やキーストロークに近い粒度で、打鍵スタイルによって
数倍変動する。**その日にアクティブだった分のユニーク個数**を指標にする。実作業時間に近く、
入力スタイルに対して不変。

1 日を 1440 bit のビットマップで表す (ADR-0002)。write 用と read 用の 2 枚。
集合演算なので冪等かつマージ可能で、順序依存がない。

**並びは上位ビットから。** 分 m (ローカル時刻の 0:00 からの分) はバイト `m >> 3` の `0x80 >> (m & 7)`。
0:00 がバイト 0 の最上位、23:59 がバイト 179 の最下位 (`src/shared/bits.ts`)。

### read / write

| | 意味 |
|---|---|
| write | 自分の編集があった分 |
| read | 閲覧のみの分。スクロール・カーソル移動を含む |

同一の分に両方あれば write を優先する。サーバ側で `r_effective = r & ~w` として実現する。
これにより write と read は構造的に排他になり、`total = w + r` が二重計上なしで成立する。

### 付随指標 (ツールチップ用)

- `pages` その日に編集したユニークページ数
- `created` その日に新規作成したページ数。プレースホルダーは含めない

### 活動の概観 (4 軸)

**2026-09-26 に決めて実装した** (ADR-0021。送信と保存 #151、振り分け #152、概観の SVG #153、ダイアログ・`/account`・トップに並べる #154)。GitHub の Activity overview にならい、書いた分をどのページに書いたかで 3 つに分け、
読んだ分を 4 つ目にする。**単位はすべて分で、軸どうしは重ならない。**

| 軸 | 数えるもの | 持ち方 |
|---|---|---|
| 作る | その日に自分が新しく作ったページに書いた分 | `wc` = popcount(c) |
| 関わる | 他の人が作ったページに書いた分 | `wo` = popcount(o) |
| 育てる | 自分が前に作ったページに書いた分 | **送らない。** max(0, w − wc − wo) |
| 読む | 読んだだけの分 | r (上の `r & ~w`) |

- `c` と `o` は端末の中だけの 1440 bit のビットマップで、どちらも `w` の部分集合。**同じ分は `c` > `o` の順に 1 つにしか数えない**
  (作る > 関わる > 育てる。`wo = popcount(o & ~c)`)。サーバへは popcount だけを送る (ビットマップのままだと URL が §9 の上限を超える)
- ページの種類はセンサーが REST で判定する (§9 のセンサー)。判定できなかった分は `c` にも `o` にも立てず、育てるに入る
- 1 つの端末の中では 4 軸の合計が `w + r` に一致する。端末をまたぐと `wc` / `wo` は max で守る (§5) ので、`wc + wo` が `w` を超えうる。
  育てるを 0 で打ち切るのはそのため
- **`links`** その日に作ったリンクの件数。**軸にはしない** (書くことに含まれて重なる)。JSON に載せるだけ (Issue #155)

### 時間帯の区間

**2026-10-07 に決め、#209 で実装した** (ADR-0024、#208、`src/worker/segments.ts`)。カードの図 (§8) の、曜日 × 時間帯の草のために、1 日の分を 4 つの区間に分けて数える。

| 区間 | 時刻 (端末のローカル時刻) | 分 | 書いた分 | 読んだだけの分 |
|---|---|---|---|---|
| 0 | 0:00〜9:00 | 0〜539 | `sw0` | `sr0` |
| 1 | 9:00〜13:00 | 540〜779 | `sw1` | `sr1` |
| 2 | 13:00〜18:00 | 780〜1079 | `sw2` | `sr2` |
| 3 | 18:00〜24:00 | 1080〜1439 | `sw3` | `sr3` |

- `swN = popcount(w の区間 N)`、`srN = popcount((r & ~w) の区間 N)`。**区間の合計はその日の `w + r` に一致する**
- 図の時間帯は 朝 9–13 / 昼 13–18 / 夜 18–9 の 3 つで、**夜は D の区間 3 と D+1 の区間 0 を足して描く** (その日の夜)。
  保存を暦の日ごとにするのは、受け口が受け取った日とは別の日の行を書かずに済むため (ADR-0024 決定 2)
- ビーコンは変えない。受け口がマージした後のビットマップから数える (§6)

---

## 5. D1 スキーマ

**段階 3 で作ったのは `graphs` / `daily` / `daybits` だけ** (2026-09-14、`migrations/0001_init.sql`、Issue #36)。
**`keys` は段階 4 より先に作った** (2026-09-14、`migrations/0002_keys.sql`、Issue #54)。記録の疎通確認の試験用の公開鍵
(どの uid にも書けた) を消すため、受け口が `keys` を引くようにした。行を入れるデバイス登録は段階 4 なので、それまでは空で記録は全部 403 になる。
**`keys.last_seen` はまだ作っていない。**

**`enroll_tokens` はデバイス登録と一緒に作った** (2026-09-14、`migrations/0004_enroll_tokens.sql`、Issue #61)。
トークンを発行する `/auth/callback` は OAuth クライアントが要るのでまだ無く、本番では空のまま。

**`users` はデバイス登録でも作らなかった** (2026-09-14、Issue #61)。登録に要るのは `keys` と `graphs` だけで、
読むコードも書くコードも無い。`tz` の設定か `last_seen` の記録が要るときに作る。
`users.last_seen` と `keys.last_seen` は送信のたびの書き込みになるのに §11 の予算に入っていないので、
そのときに要否を決める。**`users.ver` は作るときに落とす。** 「ETag 兼用」だったが、
ETag を本文の SHA-256 にした (ADR-0015 決定 2) ので使い道が無い。

```sql
CREATE TABLE users (
  uid       TEXT PRIMARY KEY,            -- HMAC(WORKER_SECRET, "google:"+sub)[0:160bit] の base64url (27 文字)
  tz        TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  ver       INTEGER NOT NULL DEFAULT 0,  -- ETag 兼用 (段階 4 で作るときに落とす)
  created   INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
) WITHOUT ROWID;

-- デバイスごとの公開鍵。行は約 120 バイトと小さいので WITHOUT ROWID
CREATE TABLE keys (
  uid TEXT, kid TEXT,
  pubkey BLOB NOT NULL,          -- 65 バイトの非圧縮 SEC1
  created INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,    -- まだ作っていない (段階 4 で要否を決める)
  PRIMARY KEY (uid, kid)
) WITHOUT ROWID;

-- 登録トークン。/auth/callback が発行し、/v1/enroll.gif が 1 回だけ使う
CREATE TABLE enroll_tokens (
  token_hash TEXT NOT NULL PRIMARY KEY,  -- SHA-256(トークン) の 16 進 64 桁。トークンそのものは保存しない
  uid        TEXT NOT NULL,
  expires    INTEGER NOT NULL            -- unix 秒。発行から 300 秒
) WITHOUT ROWID;

-- 共有 URL の解決表。全体用とプロジェクト別が混在する
CREATE TABLE graphs (
  public_id TEXT PRIMARY KEY,
  uid       TEXT NOT NULL,
  ph        TEXT NOT NULL       -- '*' なら全体
) WITHOUT ROWID;

-- 集計値。永続
CREATE TABLE daily (
  uid TEXT, ph TEXT, day TEXT,
  w INTEGER NOT NULL DEFAULT 0,
  r INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  wc INTEGER NOT NULL DEFAULT 0,       -- 作る (分)。ADR-0021、migrations/0005 (#151)
  wo INTEGER NOT NULL DEFAULT 0,       -- 関わる (分)。同上
  links INTEGER NOT NULL DEFAULT 0,    -- 作ったリンクの件数。同上
  sw0 INTEGER, sw1 INTEGER, sw2 INTEGER, sw3 INTEGER,  -- 区間ごとの書いた分 (§4)。NULL = 内訳なし。ADR-0024、migrations/0006 (#208)
  sr0 INTEGER, sr1 INTEGER, sr2 INTEGER, sr3 INTEGER,  -- 区間ごとの読んだだけの分 (r & ~w)。同上
  PRIMARY KEY (uid, ph, day)
) WITHOUT ROWID;

-- 冪等マージ用のビットマップ。Cron で 90 日より古いものを削除
CREATE TABLE daybits (
  uid TEXT, ph TEXT, day TEXT,
  wbits BLOB NOT NULL,   -- 180 バイト
  rbits BLOB NOT NULL,
  PRIMARY KEY (uid, ph, day)
);
```

プロジェクトのラベルを保持するテーブルは作らない (ADR-0007 の改訂)。

### 合算は `ph = '*'` の行で持つ

**プロジェクト別の `w` を合計してはいけない。** タブを切り替えて 2 つのプロジェクトで作業した分は
両方のビットマップに bit が立つので、合計すると同じ分を二重に数える。

クライアントが**全プロジェクトを OR した合算ビットマップ**を `ph = '*'` として一緒に送る。
OR 済みの正しい値が永続化され、サーバ側で計算する必要がない。複数デバイスでも `*` 行同士が
OR されるので整合する。

bit を立てるときは「現在のプロジェクトの行」と「`*` の行」の両方に立てる。
`ph` のバリデーションは **16 桁の 16 進数か `*` のみ許可**する。

### インデックスを増やさない

**インデックス列を更新すると書き込みが 1 行余分にカウントされる** (テーブル本体とインデックスで
2 行)。`graphs` に `uid` のインデックスを張らない。uid から引く必要があるのは削除のときだけで、
`daily` の主キー前方一致で `ph` の一覧が取れる。

### なぜビットマップを別テーブルにするか

`WITHOUT ROWID` が効くのは行が小さいときだけ (目安はページサイズの 1/20)。
ビットマップを同じ行に置くと 360 バイトを超えて利点が消える。分けておけば古いビットマップだけ
捨てられる。

### `daily` は w と合計を max で守る

`daybits` が Cron で消えた後に古い日のビーコンが届くと、ビットマップが新規作成されて集計値が
小さくなりうる。これを max で防ぐ。

**w と r を別々に max で更新してはいけない** (2026-09-14 改訂、ADR-0002)。`r = popcount(r & ~w)` は OR に対して
単調でなく、読みだった分が後から書きになると r は減る。独立に max を取ると古い r が残り、同じ分を 2 回数える。

```
w'     = max(w_old, w_new)
total' = max(w_old + r_old, w_new + r_new)
r'     = total' − w'
pages' = max(pages_old, pages_new)、created も同じ
wc'    = max(wc_old, wc_new)、wo と links も同じ (ADR-0021)
sw_k'  = max(sw_k_old, sw_k_new)                          区間 k = 0..3 (#208)
sr_k'  = max(sw_k_old + sr_k_old, sw_k_new + sr_k_new) − sw_k'
```

**時間帯の区間** (2026-10-07、Issue #208、`migrations/0006_daily_segments.sql`)。暦の日 (クライアントのローカル日付) を
0–9 / 9–13 / 13–18 / 18–24 時の 4 区間に分け、マージした後のビットマップから区間ごとの `popcount(w)` と `popcount(r & ~w)` を数える
(`src/worker/segments.ts`)。区間の和は w / r に一致する。夜 (18–9) は描画するときに「D の区間 3 + D+1 の区間 0」として組むので、
受け口はほかの日の行を書かない。**保存済みが NULL (列を足す前の行) なら max を取らずに新しい値を書く** (SQLite の `max` は
引数に NULL があると NULL を返すので、SQL では `CASE` で分ける)。既存の行は Cron が daybits の残る 90 日分だけ遡って埋め
(1 回 500 行まで)、それより古い行は NULL のままになる。

`wc` / `wo` / `links` はビットマップを持たない (送るのは数だけ) ので、`pages` / `created` と同じく max でしか守れない。
複数端末では少なめに出る (Issue #71)。**`wc + wo` は `w` を超えうる** (§4)。

**時間帯の区間 (§4) も、区間ごとに w と合計を max で守る** (ADR-0024。#209 で実装、#208)。

```
swN'     = max(swN_old, swN_new)
totalN'  = max(swN_old + srN_old, swN_new + srN_new)
srN'     = totalN' − swN'
```

- `_new` はマージした後のビットマップから数えた値。`_old` が NULL (内訳なし) なら `_new` をそのまま使う
- 受け付けた日には常にビットマップがある (上の窓) ので、普段は max がマージした値そのものになり、区間の合計は `w + r` に一致する
- **列を足す前の日は NULL のまま残る。** `daybits` が残っている日 (90 日) は Cron が遡って埋める (§6 の Cron)。それより古い日は内訳が戻らない

- 保存済みのビットマップがある日は、マージした集合が保存済みを含むので w も合計も既存以上になり、max はマージした値そのもの。
  **受け付ける窓 (30 日) を保持日数 (90 日) より短くしてある**ので、受け付けた日には常にビットマップがある
- ビットマップが無い日も、w と合計が減らず、二重にも数えない。内訳 (w と r の分け方) はずれうる
- SQL の `DO UPDATE SET` でも同じ式で守る。右辺の `daily.*` は更新前の値を指す

### 同時の送信でビットを失わない

読んでから書くまでの間に別の送信 (別のタブや端末) が同じ `daybits` を書くと、素朴な UPSERT は
そのビットを上書きして消す (2026-09-14 追加)。**楽観的に書く。**

- 既存の行は `UPDATE ... WHERE wbits = <読んだ値> AND rbits = <読んだ値>`、無かった行は `INSERT ... ON CONFLICT DO NOTHING`
- 1 行も変わらなければ 500 を返し、クライアントに再送させる。毎回全量を送る (ADR-0002) ので再送すればそろう
- `daily` は同じ batch で書いてよい。上の規則は、古い読み取りから計算した値で書いても減らさず、二重にも数えない

### SQLite の注意

- `INSERT ... SELECT ... ON CONFLICT` には **`WHERE true` が必須** (パース曖昧性)
- `max(x, excluded.x)` はテーブル名で修飾する。1 引数の `max(x)` は集約関数でエラーになる
- conflict target は明示する
- 1 クエリのバインドパラメータは 100 個まで。Free プランは 1 invocation 50 クエリまで

---

## 6. Worker API

ベース URL は環境変数で設定可能にする。

### `GET /auth/start` と `GET /auth/callback`

§3 のフロー。`/auth/callback` は HTML を返し、`postMessage` を送ってコードを表示する。

**実装した** (2026-09-14、`src/worker/auth.ts`、Issue #61)。どちらも **GET だけ** (HEAD・POST は 404。code を交換させない)。

callback の手順。**cookie と state が通るまで Google に fetch しない。**

1. オリジンが `PUBLIC_ORIGIN` でなければ 404
2. cookie の署名・期限 (400、署名違いは 403)
3. `state` がちょうど 1 つで cookie と一致 (定数時間比較。403)
4. `error` (利用者の取り消しは `access_denied`。400)。`error_description` は画面にもログにも出さない
5. `code` (400) → トークンエンドポイントに form POST (client_secret_post、code_verifier)
6. ID トークンを検証 (`idtoken.ts`、nonce は cookie から) → `uidOf` → `issueEnrollToken` → 200 の HTML

**応答は成功でも失敗でも cookie を消す** (`Max-Age=0`)。開き直しても Google に行かずに止まる。

| | 状態 | 画面の `data-error` |
|---|---|---|
| 登録トークンを発行した | 200 | (コードを表示) |
| cookie が無い・形・期限切れ・重複 | 400 | `expired` |
| cookie の署名・state が違う | 403 | `expired` |
| 取り消し / それ以外の `error` | 400 | `cancelled` / `failed` |
| `code` が無い・512 文字超、トークンエンドポイントが 4xx | 400 | `failed` |
| トークンエンドポイントが 5xx・通信失敗・応答が壊れている、JWKS が取れない | 502 | `failed` |
| ID トークンの検証で拒否 | 403 | `failed` |
| D1 の throw | 500 | `failed` |
| 設定 (vars・secret) が欠けている | 500 | (text/plain) |

ログは `{"event":"auth","step","status","reason","detail"}` の 1 行だけ。`detail` は ID トークンの拒否理由 (`nonce`・`aud` など) だけで、
**code・state・cookie・ID トークン・sub・uid・トークン・例外のメッセージは出さない。**

### `GET /v1/enroll.gif` — デバイスの登録

```
?v=1&u=<uid>&k=<公開鍵 base64url>&tok=<登録トークン>&sig=<base64url>
```

**段階 4 のうち、OAuth クライアントを待たずに実装した** (2026-09-14、`src/worker/enroll.ts`、Issue #61)。
~~トークンを発行する `/auth/callback` がまだ無いので、本番では全部 403 になる。~~
(2026-09-14 の時点。`/auth/callback` は同日に #65 で入り、2026-09-15 に持ち主が 2 つのブラウザで登録まで確かめた (#61)。)

1. **形を見る (400)。** `src/shared/enroll.ts` の `parseEnrollQuery`。キーは 5 つちょうど、`k` は 65 バイト、
   `tok` は 16 バイト、`sig` は 64 バイトの正規な base64url
2. **公開鍵を読み込み (400)、その鍵で `sig` を検証する (403)。** ここまで D1 に触らない
3. 1 回の batch (トランザクション) で、トークンのハッシュ・uid・期限が合うときだけ `keys` と全体用の `graphs` を INSERT し
   (`ON CONFLICT DO NOTHING`)、**トークンを `DELETE ... RETURNING` で消す**
4. 200 と透過 GIF。**幅は 16 + ビット (1 = 新しく登録した)**。登録済みの鍵を別のトークンで送ると 16

**当初の形から変えたところ。**

- **登録する鍵そのもので署名させる** (`sig`。ADR-0009 の改訂)。署名対象は `"/v1/enroll.gif\nv=1\nu=…\nk=…\ntok=…"`。
  壊れた鍵 (秘密鍵と公開鍵の取り違え、IndexedDB から読み戻せない鍵) ではトークンを消費しない
- **`v=1` を足した** (`/v1/p.gif` と揃える)。トークンは 1 回しか使えないので `t` (リプレイ窓) は持たない
- **UPSERT ではなく `DO NOTHING`。** 登録済みの鍵の `created` を書き換えない
- **トークンは 128 bit。D1 にはその SHA-256 だけを持つ。** D1 が漏れても期限内のトークンを使えない
- **トークンは、期限切れや uid 違いでも最初に提示された時点で消す。** 残すと uid を変えながら何度でも試せる

応答。

| | 状態 | 本文 |
|---|---|---|
| 登録した / 登録済み | 200 | 幅 17 / 16 の透過 GIF。`Cache-Control: no-store` |
| 形・曲線上に無い公開鍵 | 400 | text/plain |
| 署名・知らないトークン・期限切れ・uid 違い | 403 | text/plain |
| D1 の throw | 500 | text/plain (batch が戻るのでトークンは残る) |

**GET だけ受ける。** HEAD でトークンを消費させない (404)。
ログは `{"event":"enroll","status","reason"}` の 1 行だけ。**uid・kid・トークン・そのハッシュは出さない。**

### `GET /v1/p.gif` — 記録

```
?v=1&u=<uid>&d=<kid>&t=<unix秒>&p=<ph>|<day>|<wbits>|<rbits>|<pages>|<created>;...&sig=<base64url>
```

**段階 3 で実装した** (2026-09-14、`src/worker/ingest.ts`、Issue #36)。手順は実装の順に改めた。

1. **形を見る (400)。** `src/shared/beacon.ts` の `parseIngestQuery` が厳密に読む
2. **`day` の窓を見る (400)**
3. **`t` の窓、鍵、署名を見る (403)。** 鍵は `keys` から読むが、ここまで書き込まない。無効な署名は書き込みに近づかせない
4. `graphs`・`daybits`・`daily` を 1 回の batch でまとめて SELECT する (`(ph, day) IN (VALUES ...)`)
5. Worker 内で OR してから popcount。`r_effective = r & ~w`。`daily` は w と合計を max で守る (§5)。
   **時間帯の区間 (§4) もここでマージした後のビットマップから数える** (ADR-0024。#209 で実装、#208)。ビーコンの形は変えない
6. **変化したエントリだけを書く。** 無い `graphs` の INSERT、楽観的な `daybits` の書き込み (§5)、`daily` の UPSERT を 1 回の batch で送る。
   変化が無ければ書き込みの batch を送らない (no-op な UPDATE の課金に依存しない)
7. **200 と透過 GIF** を返す。**幅は 16 + ビット (1 = 書いた)** (2026-09-14 改訂)

**当初の手順から変えたところ。**

- 署名が 64 バイトかどうかは形の段で見る。DER は「署名が違う」(403) ではなく「形が違う」(400) になる
- 当初の手順 1 は「署名を検証する」が「鍵を引く」より前に書かれていたが、鍵が無ければ検証できない
- `graphs` を送信のたびに UPSERT しない。読みの batch で有無を見て、無いものだけ INSERT する
- **`ver` を +1 しない。** ETag が本文の SHA-256 になった (ADR-0015 決定 2) ので使い道が無く、送信のたびの書き込みになる
- **応答の幅で「書いた」を返す。** 持ち主は本番の D1 を覗けない (リモート操作は CI だけ。ADR-0014) ので、
  同じ中身を 2 回送って 2 回目が 16 になることを利用者の側で確かめる手段にする。16 から始めるのは、途中の何かが返した
  1×1 の画像を「届いた」と取り違えないため (`/v1/probe.gif` と同じ)。段階 5 の送信済みの判定は「幅が 16 か 17」で読める
- **鍵は `keys` テーブルを (uid, kid) で引く** (2026-09-14、Issue #54)。記録の疎通確認 (#36) では `wrangler.jsonc` の `TRIAL_PUBLIC_KEY` 1 本で、
  kid が合えばどの uid にも書けた。**鍵を引く段で D1 が失敗したら 500** (書き込みの失敗と同じく再送させる)

バリデーション。

- キーは `v`・`u`・`d`・`t`・`p`・`sig` の 6 つちょうど。**欠け・未知のキー・重複キーは拒否する**
- `u` は 20 バイトの正規な base64url (27 文字)、`d` は 16 桁の小文字 16 進数、`t` は先頭に 0 の無い整数
- `ph` は 16 桁の 16 進数か `*` のみ
- `day` は実在する日付 (2026-02-30 を弾く)
- **`day` が未来なら拒否する。** システム時計を進めるだけで未来の草が生えてしまう。day はクライアントのローカル日付なので、
  `(UTC 現在 + 14h) の日付` までは受ける (UTC+14 の地域の今日)
- **30 日より古い `day` は拒否する。** 導入前の活動は遡らない (ADR-0012)。`(UTC 現在 − 12h) の日付` から数える
- **エントリが 1 つでも窓の外なら全体を拒否する**
- ビットマップは 240 文字 (180 バイト)。`pages` / `created` は先頭に 0 の無い 0〜99,999
- 1 リクエストの `(ph, day)` は 1〜14 件で、重複を拒否する。空のエントリ (`;;` や末尾の `;`) も拒否する
- **GET だけ受ける。** HEAD では書き込ませない (404)

応答。

| | 状態 | 本文 |
|---|---|---|
| 書いた / 変化なし | 200 | 幅 17 / 16 の透過 GIF。`Cache-Control: no-store` |
| 形・日付の窓 | 400 | text/plain |
| 時刻の窓・鍵・署名 | 403 | text/plain |
| D1 の throw (鍵の読み取りを含む)・楽観的な書き込みの衝突 | 500 | text/plain |

**D1 の書き込みが throw したら 500 を返す。** 画像が返らないのでクライアントは `onerror` で
失敗を知り、送信済みフラグを立てない。D1 のエラーには数値コードがないので、エラー種別に
依存せずこの分岐にする。

ログは `{"event":"ingest","status","reason","entries","changed"}` の 1 行だけ。**uid・ph・kid・日付・IP は出さない。**
1 invocation の文は多くて 32 本 (Free の上限 50)、1 文のバインドは 29 個以下 (上限 100)。

#### v2 (ADR-0021。2026-09-26、#151)

```
?v=2&u=<uid>&d=<kid>&t=<unix秒>&p=<ph>.<day>.<wbits>.<rbits>.<pages>.<created>.<wc>.<wo>.<links>&p=...&sig=<base64url>
```

- **エントリの末尾に `wc` (作る分)・`wo` (関わる分)・`links` (作ったリンクの件数) を足す** (§4)
- **区切りを URL エンコードされない文字にする。** フィールドは `.`、エントリは `p` を繰り返す。v1 の `|` と `;` は `%7C` / `%3B` の 3 文字になっていた。
  どのフィールドの文字集合にも `.` は無い (base64url は `-` と `_`、日付は `-`、ph は 16 進か `*`)
- キーの重複を拒否する規則は `p` にだけ当てない。`p` は 1〜14 個
- `wc` / `wo` は先頭に 0 の無い 0〜1440、`links` は 0〜99,999。**`wc + wo` がそのエントリの `wbits` の popcount を超えたら 400。**
  1 つの端末の `c` と `o` は `w` の部分集合で互いに重ならないので、正しいクライアントからは超えない
- **移行のあいだは `v=1` も受ける** (ADR-0021 決定 5 の改訂)。v1 のエントリは `wc` / `wo` / `links` を 0 として読む。組み立てるのは v2 だけで、配布ページ `v1` を貼り替えたら止める (#159)
- 署名対象の正規化 (`src/shared/sign.ts`) の形はそのままで、**`p=` の行をエントリの数だけ出現順に並べる** (v1 は 1 行)
- 長さの見積もり: 1 エントリは最大 529 文字 + 区切り 8 + `&p=` 3 = 540 文字。**最悪の 14 件で約 7,750 文字** (本体とほかのキーで約 190 文字)。
  v1 の区切りのまま 3 フィールド足すと約 7,970 文字で、8,000 にほぼ余裕が無い

### `GET /v1/revoke.gif` と全削除

```
GET /v1/revoke.gif?v=1&u=<uid>&d=<kid>&x=<消す kid>&t=&sig=     デバイスの失効
```

**全レコードの削除は画像ビーコンをやめた** (2026-09-15、ADR-0018、Issue #88)。管理のページ (`/account`) の
POST で行う。破壊的な操作に Google サインインを必須にでき、端末の鍵だけでは全削除できない。

**`DELETE` メソッドは使えない。** CSP が `connect-src` を塞いでいるので UserScript から送れない。
破壊的操作も画像ビーコンになるため、**リプレイ窓を 60 秒に縮め `confirm=1` を必須にする**。
署名が要るのでリンクプレビューのクローラでは叩けない。

**失効を実装した** (2026-09-15、`src/worker/enroll.ts` の `handleRevoke`・`src/shared/revoke.ts`・
`src/userscript/revoke.ts`、Issue #79)。

- **失効は `keys` の行の削除。** `revoked` 列は足さない。登録し直すには Google の ID トークンが要るので、
  行が無い状態がそのまま締め出しになる
- 順は記録の受け口と同じ。形 (400) → 時刻の窓 60 秒 (403) → 署名する鍵を引く (403) → 署名の検証 (403) → 削除。
  **署名が通るまで書き込みに近づかせない**
- 消せるのは**同じ uid の行だけ**。`x` は自分の kid でもほかの端末の kid でもよい
- 応答は幅 16 (もう無かった) / 17 (消した)。**もう無くても 200** にする (押し直しても成功に見える)
- UserScript は**サーバが消してからローカルの鍵を消す。** 逆にすると、送れなかったときに鍵だけ失って失効できなくなる

**全削除は `/account` にある** (2026-09-15、`src/worker/account.ts`、ADR-0018)。

- **uid を持つ 5 つの表 (`daybits` / `daily` / `graphs` / `keys` / `enroll_tokens`) を 1 回の batch で消す。**
  batch はトランザクションなので、途中で失敗したら全部戻る
- **合言葉「削除」を打たせる** (画像ビーコンの `confirm=1` の代わり)
- `graphs` は uid にインデックスが無いので全走査になるが、**索引は足さない** (書き込みのたびのコストの方が効く。design §5)
- **消えるのはサーバのデータだけ。** このブラウザの記録は Cosense の「設定」の
  「このブラウザの記録を消す」で消す (`src/userscript/cleaner.ts`)。localStorage はブラウザにしかないので、
  ページからは消せない

### `GET /` と `GET /privacy` (英語)、`GET /ja` と `GET /ja/privacy` (日本語) — 人が読むページ

**トップとプライバシーポリシー** (2026-09-15、`src/worker/site.ts`、ADR-0018)。
**英語を既定にし、日本語を `/ja` の下に分ける** (2026-09-26、ADR-0022)。`/` と `/privacy` は Google の OAuth
同意画面に登録した URL なので英語にする。上端のリンク (`English` / `日本語`) で対のページへ行き来する。

- `/`・`/ja` — 何をするツールか、デモの草 (`/v1/g/demo.svg`) と活動の概観、Google サインインを使う理由、導入の 1 行、
  管理とポリシーへのリンク。**サインイン (`/auth/start`) へ直接はつながず、`/account` へ案内する** (Issue #141)。
  **セッションに依存する内容をトップに載せない** (載せると `public` なキャッシュをやめる必要が出る)
- `/privacy`・`/ja/privacy` — **`docs/privacy.en.md` と `docs/privacy.md` を正本のまま配信する。** wrangler の Text モジュール規則
  (`wrangler.jsonc` の `rules`) で読み込み、`markdown.ts` の部分集合の変換で HTML にする。
  **2 つは全訳どうしで、節・表の行・箇条書きの数をテストで突き合わせる**
- どちらも**スクリプトを 1 行も載せず**、スタイルは固定の文字列 (CSP はハッシュ)。
  中身はデプロイでしか変わらないので `public, max-age=3600`

### `GET /favicon.svg` — ページの favicon

**Cosense のページメニューのボタンと同じ絵** (2026-09-21、`src/worker/favicon.ts`、Issue #130)。
草のマス目 3×3 で、ボタンの 3 状態のうち **`synced` (青緑) を固定で使う** (Worker のページは「送っている」側)。
絵は `src/shared/grass-icon.ts` が 1 か所で作り、UserScript は data: URI に、Worker はこのパスにする。

- **data: URI にしない。** 各ページの CSP は `img-src 'self'` で、favicon の取得も `img-src` に従う。
  CSP を緩めず、同じオリジンのパスで配信する。`/`・`/privacy`・`/account`・`/auth/callback` の HTML が
  `<link rel="icon" href="/favicon.svg" type="image/svg+xml">` で指す
- 応答のヘッダは草の SVG と同じ (`image/svg+xml`・`nosniff`・`default-src 'none'`・ETag)。
  **`public, no-cache` で毎回 ETag を確かめ直させる** (2026-09-27、#186)。当初は「絵が固定なので」と
  `max-age=86400` にしていたが、ETag を確かめるのは期限が切れた後だけなので、配色を変えても最大 1 日古い絵が残った。
  変わっていなければ 304 で本文は送らない。草の 15 分は変えない
- **SVG だけを出す。** PNG や ICO を作るには Worker に画像のエンコーダを持ち込むことになり、釣り合わない。
  SVG の favicon を読まないブラウザでは既定の絵になる。**`/favicon.ico` は 404 のまま**
  (中身が SVG なのに `.ico` を名乗らせない)

### `GET /v1/guide/{name}.svg` — 説明の図

**草のダイアログの「草と活動の概観の見方」に添える、具体例に注釈を付けた静的な図** (2026-09-27、`src/worker/guide-svg.ts`、Issue #182)。
`name` は `minutes` (1 分ごとの書いた・読んだの例)・`grass` (8 週の草の例と、濃さ × 色合いの色の読み方)・
`overview` (4 軸の内訳の例と、その値から描いた実物の概観) の 3 つで、ほかは 404。

- **描くのは Worker** (ADR-0019)。色はスキーム、概観は `layoutOverview` の実物から作るので、**図と実際の草・概観の色と形がずれない**
- **ライト・既定の配色に固定する。** ダイアログは常にライト (research §3) で、UserScript は配色を選ばない
- 寸法は `src/shared/guide.ts` にあり、UserScript が `<img>` に先に確保する寸法と同じものを読む
- 応答のヘッダは草の SVG と同じ。**`public, no-cache` で毎回 ETag を確かめ直させる** (favicon と同じ。#186)。
  絵はデプロイでしか変わらないが、`max-age` を付けると配色を変えても古い図がダイアログに残る
- **クエリは見ない。** UserScript は `?v=2` を付けて貼る。`max-age=86400` の頃に取り込まれた古い図を、
  ブラウザに確実に取り直させるため (#186。ダイアログの `<img>` は後から差し込むので、強制再読み込みでも取り直されなかった)

### `GET /account` — 管理のページ

**サインインした本人だけが開けるページ** (ADR-0017・0018、2026-09-15、`src/worker/account.ts`)。
UserScript からは読めない (CSP に受信方向が無い) ので、Worker のオリジンで人が開く。
**管理はここに集約し、Cosense 側にはそのブラウザでしかできないことだけを残す** (ADR-0018)。

- **GET は一覧** — 端末 (kid と登録日時。uid も公開鍵も出さない)、合算の草 (`<img>`) と共有 URL、全削除のフォーム
- **草そのものを `<img>` で出す** (2026-09-17)。CSP は `img-src 'self'` を許す。
  URL を別のタブで開き直さずにサインインの流れのまま見られるようにするため
- **POST は失効 (`action` 無し) か全削除 (`action=delete`)**。失効の後は 303 で GET に戻す
- **全削除は合言葉を打たせる** (`word=削除`)。画像ビーコンの `confirm=1` の代わり
- セッションは `__Host-grass-session` (30 分、`src/worker/session.ts`)。`/auth/callback` の成功時にだけ発行する
- 守りは **`SameSite=Lax` + CSP の `form-action 'self'` + セッションに結び付けた CSRF トークン**の 3 つ
- **スクリプトを 1 行も載せない** (CSP は `script-src 'none'`)
- **プロジェクト別の共有 URL は出せない** (サーバはプロジェクト名を持たない。ADR-0007)

`/auth/start?to=account` で始めると、サインインの後にこのページへ戻る。
**戻り先は cookie の `mode` として署名され**、`mode=account` では登録トークンを発行しない (ADR-0018)。

### `GET /v1/probe.gif` — 送信の疎通確認

```
?v=1&d=<中身 base64url>&h=<SHA-256(d) の先頭 32 桁>
```

**記録しない接続テスト** (2026-09-13 追加、Issue #31)。D1 も認証も使わず、届いたリクエストを観測して
**GIF の幅で返す。** 画像の本文は JS から読めないが `naturalWidth` は読める。幅は 16 + ビットの和 (16〜31)。
16 から始めるのは、途中の何かが返した 1×1 の画像を「届いた」と取り違えないため。

| ビット | 意味 |
|---|---|
| 1 | `h` が `d` の SHA-256 と一致した (中身が壊れずに届いた) |
| 2 | `Referer` ヘッダが届いた |
| 4 | `Sec-Fetch-Dest` が `image` でない (Cosense の Service Worker が作り直した印になりうる) |
| 8 | `Referer` にオリジンより後ろ (パス・クエリ・フラグメント) が含まれる。URL として読めない値も含むとみなす (2026-09-14 追加) |

**Referer の値そのものは返さない。** 公開プロジェクトでの実測で Referer が届いた (research §1) ので、
そこにプロジェクト名やページ名が載っているかを、運営者が値を見ずに確かめるためにビット 8 を足した。

**UserScript からは呼ばなくなった** (2026-09-15、Issue #95)。v1 を配るのに合わせてページメニューを 1 項目に畳んだとき、
疎通確認のメニューを消した。**この受け口は残す**ので、確かめたくなったら URL を手で組んで叩けばよい
(幅の読み方は `src/shared/probe.ts` の `readProbeWidth`)。

- クエリの形が不正なら **400 と text/plain**。画像でないのでクライアントは `onerror` になる。
  `d` は base64url の文字だけで 16,384 文字まで (Cloudflare の URL の上限に合わせる)
- `Cache-Control: no-store`。`d` が乱数なので URL は毎回変わる
- ログは `{"event":"probe","bytes","flags"}` の 1 行だけ。**IP・UA・中身・Referer の値は出さない**
- GIF は幅 w × 高さ 1 の透過 GIF をコードで組み立てる。LZW は画素ごとにクリアコードを挟む非圧縮形式で、
  幅 1 のときは広く使われている 43 バイトの透過 GIF と同じバイト列になる。`/v1/p.gif` もこれを返す
- **段階 3 以降も残す。** 段階 8 の設定画面の「接続テスト」に使う。Bot Fight Mode のように画像ビーコンを
  静かに壊す要因を、利用者が切り分けられる

### `GET /v1/g/{publicId}.svg` — 共有グラフ

`publicId` が全体用かプロジェクト別かは `graphs` を引いて判定する。
**`graphs` に無い `publicId` は 404 を返す** (2026-09-13 決定。それまで規定が無かった)。
Cosense では画像が壊れて表示されるので、「無い」ことが見た目で分かる。
疎通確認のために `demo` を予約し、実データを持たない固定の草を返す。
**どのプロジェクトを描くかはクエリで指定しない。** URL 自体が対象を決める。

**D1 の記録から描く** (2026-09-14、`src/worker/graph-data.ts`、Issue #36)。

- `demo` 以外で 32 桁の小文字 16 進数でない `publicId` は、**D1 を引かずに 404**
- 四分位とバランスの中心は `ph = '*'` の全期間から取る (§7)。全体用は母集団と描く行が同じなので 1 回だけ読む。
  プロジェクト別は母集団と、そのプロジェクトの直近 53 週を 1 回の batch で読む
- **今日の列は `Asia/Tokyo` の日付で決める。** `users.tz` の既定で、段階 4 で `users` を作るまでは全員これ
- **D1 が読めなければ 503 と `Cache-Control: no-store`。** 壊れた画像を 15 分残さない

| クエリ | 既定 | 意味 |
|---|---|---|
| `theme` | `light` | `light` / `dark` |
| `weeks` | `53` | 表示週数。1〜53 |
| `mode` | `bi` | `bi` = 2 次元 / `write` = 単色。**全マスのバランスを 0 とみなすだけで、Level は合計分数のまま** |
| `palette` | `violet-amber` | 配色。今は `violet-amber` だけ (§7、ADR-0023)。消した `blue-pink` / `blue-yellow` を含め、未知の値は既定に落ちる |
| `l` | (なし) | **画像に描くプロジェクト名** (2026-09-18、Issue #119)。**サーバは保存しない** — この要求で描くだけ |
| `u` | (なし) | **画像に描く Cosense のユーザー名** (2026-09-23、Issue #134)。`l` と同じく**サーバは保存しない** |
| `year` | 今年 | **振り返る年** (`YYYY`。2026-09-18、Issue #128)。その年の 12/31 を右端にする。**今年と未来は今日が右端** |

- **不正な値と範囲外は既定値に落とす。** 画像として読まれるので、400 を返しても Cosense では
  壊れた画像になるだけで何が悪いか伝わらない。`weeks` は `^\d{1,2}$` で形を見てから範囲を見る
  (`parseInt("10abc")` が 10 になるため)。`palette` は登録表に自身のキーとしてあるかで見る
- **`year` は 4 桁の形だけ見る。** 指定は年だけで、日付までは刻ませない
  (年が分かれば「2025 年の草」として貼れる)。その年の 12/31 を右端にし、**今日より後なら今日に落とす**
  ので、今年を指定すると自然と「今日が右端」になる
- **左端は厳密な 1 月 1 日にはならない。** 草は週単位の列で並ぶので、12/31 を右端に 53 週 (371 日)
  遡ると前年の末尾が 5〜13 日ぶん入る。**1 月 1 日は必ず含まれる** (365 < 371)。
  週数を年ごとに変えると SVG の幅が変わり、`<img>` に寸法を固定している UserScript 側で絵が崩れる
- **四分位スケールと色相の中心は従来どおり `ph = '*'` の全期間から取る** (ADR-0007 決定 4) ので、
  過去を見ても現在と同じ物差しで塗られ、並べて比較できる。計測開始前の点線も開始日が全期間から
  取られるので自動で効く
- **`u` は表示を壊す文字だけを拒む** (`isValidUserName`。2026-09-23 の Issue #134、2026-09-29 の Issue #195 で改訂)。
  ユーザー名には漢字・かな・空白・`_` が普通に使われる (research §2) ので、拒むのは制御文字・行と段落の区切り・
  片割れのサロゲート・双方向の制御文字・空白だけの名前だけ。書記素で 48、UTF-16 で 256 まで。
  **`<` `&` `"` も通すので、`escapeXml` が XSS を塞ぐ要点になる** (ADR-0007 決定 2 の 2026-09-29 の改訂)。
  外れた名前は描かないだけで壊れない。UserScript は `cosense.User.name` から取り、合算にも
  プロジェクト別にも付ける (ユーザー名はプロジェクトをまたいで共通)
- **`l` は許可リストで見る** (`src/shared/project-name.ts`)。英字・数字・ハイフンで、先頭と末尾は英字か数字、
  64 文字まで (research §2 の実測 + こちらで決めた長さの上限)。**外れたら描かないだけで 400 にはしない**。
  通す文字に `<` `&` `"` が無いことが XSS を塞ぐ要点で、`escapeXml` にも通して二重にする
  (ADR-0007 決定 2 の 2026-09-18 の再改訂)
  (`toString` のような継承したキーを通さない)。未知のキーは無視する
- **`palette` は見た目だけを変える** (2026-09-13 追加、ADR-0016)。四分位のスケールにもバランスの中心にも
  効かないので、どの配色でも同じ日は同じ Level になり、比較可能性 (§7) は保たれる。
  `scale=self` を作らない理由とは衝突しない
- **ETag は本文の SHA-256** (2026-09-13 改訂、ADR-0015 決定 2)。当初は「`users.ver` と描画パラメータ
  から作る」としていたが、それだと配色やレイアウトを直してデプロイしても 304 が返り続け、古い画像が
  残る。本文から作れば描画が変わったときだけ変わる。**日付を鍵に入れる必要も無くなる** (今日の列が
  進めば本文が変わる)。`If-None-Match` は RFC 9110 どおり弱い比較で見て 304 を返す
- `Cache-Control: public, max-age=900`。送信が 1 日数回なので短くする意味がない。
  Workers Cache を有効にすればヒット時は Worker を実行せず、日次リクエスト枠も節約できる
- `Content-Type: image/svg+xml; charset=utf-8` を必ず付ける。これがないと Cosense で表示されない

### `GET /v1/g/{publicId}/overview.svg` — 活動の概観

**ADR-0021。2026-09-26、`src/worker/graph-data.ts` の `renderStoredOverview`、#153。** 草と同じ `publicId` の、4 軸 (§4) のレーダー。**草の SVG は変えない** (ゴールデンテストと ETag を保つ)。

- 対象の解決・`demo`・404・503・ETag・304・`Cache-Control`・`Content-Type`・セキュリティヘッダは**草と同じ処理を共用する**
- 期間は草と同じクエリ `weeks` / `year` で決め、**その期間の `daily` の行を合計する** (草と同じ期間を同じ読み方で読む)。今日の列の決め方も同じ
- 受けるクエリは `theme` / `palette` / `weeks` / `year`。`mode` / `l` / `u` は受けない (未知のキーと同じく無視する)
- 4 軸の値は期間の合計で、`作る = Σwc`、`関わる = Σwo`、`育てる = Σmax(0, w − wc − wo)` (日ごとに打ち切ってから足す)、`読む = Σr`
- `demo` は作る・関わるの値も持つ固定のデータから描く (`/v1/g/demo/overview.svg`)
- 描き方は §8

### `GET /v1/g/{publicId}/card.svg` — カードの図

**ADR-0024。2026-10-07 に決め、#212 で実装した (#208)。** 草と同じ `publicId` の、ページカードのサムネ向けの 1 枚 (曜日 × 時間帯の草と 4 軸の線)。
**草と概観の SVG は変えない。**

- 対象の解決・`demo` (`/v1/g/demo/card.svg`)・404・503・ETag・304・`Cache-Control: public, max-age=900`・`Content-Type` は草と同じ処理を共用する
- 期間は右端の日から **26 週**。右端の日の決め方は草と同じ。`weeks` / `year` は受けない
- 表示する行と、`ph = '*'` の母集団 (四分位とバランスの中心。時間帯ごとの値から取る) を 1 回の batch で読む
- 夜の時間帯は `D の区間 3 + D+1 の区間 0` で組み立てる (§4)。区間が NULL の日は「内訳なし」として、その日の合計の色を 3 マスに薄く塗る
- 4 軸の線は、概観と同じ式 (上の `overview.svg`) で期間の合計を出し、割合で分ける

| クエリ | 既定 | 意味 |
|---|---|---|
| `lang` | `ja` | ラベルの言語。`en` 以外は `ja` |
| `theme` | `light` | `light` / `dark` |
| `l` | (なし) | 描くプロジェクト名。草と同じ検証 (`project-name.ts`) で、サーバは保存しない |
| `u` | (なし) | 描く Cosense のユーザー名。草と同じ検証 (`isValidUserName`) で、サーバは保存しない |

**アイコンの埋め込み。** `l` と `u` がそろい、合算でないときは、`https://scrapbox.io/api/pages/<l>/<u>/icon` (research §4) を Worker が引き、
`data:` の URI で SVG に埋め込む (`<img>` で読まれた SVG は外部の画像を読まないため)。

- 転送を辿る先は `gyazo.com` / `i.gyazo.com` / `scrapbox.io` / `storage.googleapis.com` に限る。小さいサイズで取る (Gyazo なら `max_size` を小さくする)
- 種類は png / jpeg / gif / webp だけ。SVG は入れない。大きさの上限を超えたら捨てる
- 結果は失敗も含めて `caches.default` に置く (例: 成功 1 日、失敗 1 時間)。**D1 には保存しない**
- 取れないとき (非公開プロジェクト・404・失敗) はアイコンを出さず、名前だけにする。デモは固定の小さな画像を埋め込み、外へ取りに行かない

### `GET /v1/g/{publicId}/{dataKey}.json` — 日ごとの集計値

**2026-09-24、ADR-0020** (`src/worker/json.ts`)。その `(uid, ph)` の `daily` を**全期間**、日付の昇順で返す。

```json
{
  "total": true,
  "days": [{ "day": "2026-09-01", "w": 12, "r": 30, "pages": 3, "created": 1 }]
}
```

**各日に `wc` / `wo` / `links` を足した** (2026-09-26、ADR-0021、#151)。育てるは足さない (`w − wc − wo` から出せる。0 で打ち切ることは §4)。

- **草と同じ `publicId` に `.json` を付けるだけにしない。** `dataKey = SHA-256("data:" + uid + ":" + ph)[0:32]` を並べる。
  計算に uid が要るので、**草の URL を受け取った人は JSON の URL を作れない** (§10)
- **表を持たない。** `graphs` を `publicId` で引いて `(uid, ph)` を得て、`dataKey` を計算し直して定数時間で比べる
- `publicId` か `dataKey` の形が 32 桁の小文字 16 進でなければ D1 を引かずに 404。`graphs` に無いのと鍵が違うのは**区別せず 404**
- `total` は合算 (`ph = '*'`) か。**uid も ph も本文に出さない。** 絵のクエリ (`weeks` / `year` など) は受けない
- `pages` / `created` は複数端末で少なく出ることがある (Issue #71)
- **D1 が読めなければ 503 と `Cache-Control: no-store`** (草と同じ)
- ETag・304・`Cache-Control: public, max-age=900` は草と同じ

| ヘッダ | 値 | 理由 |
|---|---|---|
| `Content-Type` | `application/json; charset=utf-8` | |
| `Access-Control-Allow-Origin` | `*` | ほかのサイトのスクリプトから読ませる。Cookie を使わない公開の値。Cosense の中からは CSP で読めないのは変わらない |
| `X-Robots-Tag` | `noindex` | URL が公開の場に貼られても検索に拾わせない |
| `Content-Security-Policy` | `default-src 'none'` | 直接開いても何も読ませない |

**URL を出すのは `/account` の合算と、UserScript の草のダイアログ** (2026-09-26、#164)。サーバはプロジェクト名を持たないので、`/account` に出せるのは合算だけ。
UserScript は uid を持つので、ダイアログでは合算にもプロジェクト別にも「URL をコピー」と「開く」を置き、渡すと内訳まで読めることを添える。

### セキュリティヘッダ

SVG と JSON のレスポンスに付ける。

```
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'
X-Content-Type-Options: nosniff
```

**`/auth/callback` の HTML** (2026-09-14、`src/worker/auth-page.ts`、Issue #61)。

```
Content-Security-Policy: default-src 'none'; script-src 'sha256-…'; style-src 'sha256-…'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Cache-Control: no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

- **値をスクリプトに埋め込まない。** スクリプトとスタイルは固定の文字列で、コードは `data-code` 属性から読む。CSP をハッシュで書け、値で CSP が変わらない。
  ハッシュは標準の base64 (パディングあり) で、テストが HTML の中身と突き合わせる
- **COOP を付けない。** `same-origin` を付けると opener が切れて postMessage が壊れる (research §6)
- **`img-src 'self'` は favicon のため** (2026-09-21、Issue #130)。ページの中に画像は無い
- スクリプトは `postMessage` を `https://scrapbox.io` だけに送り、`history.replaceState` でアドレスバーと履歴から code と state を消す

**カードの図 (`card.svg`) だけは `img-src data:` を足す** (埋め込んだアイコンのため。ADR-0024。#212 で実装)。
草と概観のヘッダは変えない。

ラベルをサーバに置かないので SVG に出る動的な文字列は日付と数値だけだが、
**原則として全て XML エスケープする**。

### Cron

- 90 日より古い `daybits` を削除する (`daily` に集計済みなので情報は失われない)。**段階 3 で実装した** (`src/worker/cron.ts`)。
  境界は UTC の今日の 90 日前で、その日は残す
- 使われずに期限が切れた登録トークン (`enroll_tokens`) を削除する (2026-09-14、Issue #61)。使われたものは受け口がその場で消す
- 30 日以上送信のない `uid` をログ出力する。**`users.last_seen` が要るので段階 4 以降**
- **時間帯の区間 (§4) が NULL で、`daybits` が残っている `daily` の行を遡って埋める** (ADR-0024。#209 で実装、`backfillDailySegments`。1 回 500 行まで、#208)。
  1 回あたりの行数に上限を設け、書き込みの予算 (§11) を守る

---

## 7. 配色

### スキームで差し替える

**配色は「スキーム」という部品に閉じ込める** (2026-09-13 改訂、ADR-0016)。スキームは Level・バランス・
テーマを受け取って `#rrggbb` を返すだけの純粋な関数で、描画側は中身を知らない。

**Level とバランスの計算は配色に依らない。** 下の「四分位スケール」と「バランス」がそれで、
どの配色でも同じ日は同じ Level と同じバランスになる。配色はそれを色にするだけ。

| 名前 | 作り方 | 内容 |
|---|---|---|
| `violet-amber` | 表 | 5 列 × 4 段。紫 → 紫みの青 → 青緑 → 黄みの緑 → 琥珀。**色覚の型を問わず 3 段階が見分けられる** |

**配色は今はこの 1 つだけ** (2026-09-27、ADR-0023)。以前の `blue-pink` (既定) と `blue-yellow` は消した。
`?palette=` と差し替え口は残してあり (§6)、配色を足すときは `bandScheme()` に表を渡す。列ごとの 4 段の 16 進、
列の境界、Level 0 の色、凡例の見本を書く。規則で計算したいならスキームを直接実装してもよい。

**登録したスキームは同じ契約テストに通す。** 全 Level × バランス × テーマで 16 進を返す、
Level 0 が Level 1〜4 と違う、凡例の見本が −1〜+1 に収まる、**Level が上がるとライトは暗くダークは
明るくなる** (GitHub と同じ向き)。**色覚のテストにも通す** (`scheme-cvd.test.ts`、下の「配色」の節)。

- **凡例もスキームから作る。** スキームが列ごとのバランスの見本を持つ (§8)
- **write モードは全マスのバランスを 0 とみなす。** スキームごとの特別扱いは無い

**既定の配色を変えると、`palette` を付けずに貼った全員の草の色が変わる。** 変えるときは ADR を残す。

### 四分位スケール

GitHub と同じ方式。**合計がデッドゾーン (3 分) 未満の日を母集団から除外**し、`Q3 + 1.5 × IQR` で
外れ値を落としてから四分位を取る。四分位は線形補間 (type 7)。

**0 の日だけでなくデッドゾーン未満も外す** (2026-09-13 改訂、ADR-0015)。20 秒ポーリングで
1〜2 分の日は多く出るので、残すと四分位が小さい値に潰れる。[1,1,2,2,3,30,60] で 0 だけ除外すると
四分位が 1.25/2/2.75 になり、3・30・60 が全部 Level 4 になる。

**比較演算子は `<=` にする。** 離散値が少ないと四分位が同値に潰れ、`<` だと全マスがいきなり
Level 4 になる。テストでここを固定する。潰れたときの特別な分岐は書かない。`<=` を順に比べれば
自然に Level 1 になり、部分的に潰れたケースとも挙動がずれない。

**外れ値のフェンスも `v <= fence` で残す。** `<` にすると値が 1 種類に潰れた母集団 ([3,3,3,3]) で
フェンスが Q3 と等しくなり、全部落ちて空になる。`<=` ならフェンス ≥ Q3 ≥ 最小値で必ず 1 件以上残る。

**母集団が空なら四分位を +∞ にする。** 3 分以上の日は Level 1 になる。全部 Level 0 にすると、
プロジェクト別と合算の同期のずれ (§16) で表示すべきデータが隠れる。

**母集団は常に `ph = '*'` (全体合算) の日次データから取る。** プロジェクト別の草もこの共通の
スケールで塗る。プロジェクトごとに別のスケールにすると、活動の少ないプロジェクトも濃く見えて
並べたときの比較が成立しない。`scale=self` のようなクエリは作らない。

### バランス

読みと書きの比は典型的に 6 対 1 程度。素朴な `w / (w + r)` では全マスが読み寄りの色一色になる。
四分位と同じく中心を自分の中央値に置く。

```js
const odds = d => Math.log((d.w + 3) / (d.r + 3));
const center = median(days.filter(d => d.w + d.r >= 3).map(odds));
const balance = d => Math.tanh((odds(d) - center) / 1.2);   // -1 (読) .. +1 (書)
```

**`center` は外れ値のフェンスをかける前**の母集団から取る (上の擬似コードのとおり)。
中央値は四分位と同じ関数の p = 0.5 (偶数個なら中央 2 つの平均)。母集団が空なら 0。

**`center` も `ph = '*'` から取る。** 結果としてプロジェクトの性格が色に出る。読むだけの
プロジェクトは読み寄りの色 (紫)、書くプロジェクトは書き寄りの色 (琥珀) になる。
これは意図した挙動で、並べたときに使い方の違いが読める。

**合計の少ない日は odds が 0 (読み書き半々) に寄る。** 中心が読み寄りの人ほど、少ない日が書き寄りの
色に見える。段階 7 で扱う (#29)。

### 配色 — `violet-amber`

**色覚の型 (P・D・T) を問わず、読み寄り・中間・書き寄りの 3 つが見分けられることを最優先に選んだ** (ADR-0023)。
中間は緑で、5 列が端から端へ順に遷移して見える。GitHub の草と同じく、段階の色を表で持つ。

| | 内容 |
|---|---|
| 列 (読 → 書) | 紫 / 紫みの青 / 青緑 / 黄みの緑 / 琥珀 |
| 段 (Level 1〜4) | ライトは淡い → 濃い、ダークは暗い → 明るい |
| 列の境界 | バランス −0.6 / −0.2 / 0.2 / 0.6。**境界ちょうどは読み寄りの列** |
| Level 0 | GitHub と同じ。ライト `#ebedf0`、ダーク `#161b22` |
| 凡例の見本 | −1 / −0.4 / 0 / 0.4 / 1 (それぞれ別の列に入る値) |

- **表は計算して焼き込んだ値。** 両端と中間を OKLCH (色相 300° / 170° / 80°) で置き、明度は Level で決めて
  書き寄りほど少し上げ、間の 2 列は端と中間を OKLab で混ぜて作った。規則と値は ADR-0023 決定 1 にある。
  実行時には計算しない (`oklch()` の CSS 記法も使わない。`<img>` 経由の SVG ではブラウザ依存が読めないため)
- **彩度を合計分数で変えない。** 表の色をそのまま使う
- 真ん中の青緑を広めに取るので、典型的な日 (バランス 0 付近) は青緑にまとまる。write モードは青緑の単色
- **色覚のテストで見分けやすさを固定する** (`test/worker/graph/scheme-cvd.test.ts`)。Machado (2009) の P・D・T 型の
  シミュレーションにかけてから OKLab の色差 (×100) で比べ、Level 2〜4 の両端と中間が 8 以上、
  Level 1 と Level 0 が 4.5 以上、列が順に遷移する (隣の列は 1 つ飛ばした列より近い) ことを見る。
  **間の列 (2・4 列目) は、色覚の違いがある人には隣と同じ色に見えてよい** — 保証するのは 3 段階の読み取り
- **琥珀は明るいので、マスの色を文字に使わない。** 白地で Level 3 は 2.4:1 しかない。
  説明の図で「書いた」を色付きの文字にするときは、同じ色相で暗くした色を使う (`guide-svg.ts`)

---

## 8. SVG 出力

**寸法・色・ラベルの位置は `src/worker/graph/layout.ts` の `layoutGraph` が決め、`src/worker/svg.ts` はそれを文字列にするだけ** (2026-09-15、Issue #73。置き場は Issue #110 で `src/shared/` から移した)。
**草を描くのはここだけ** (ADR-0019、Issue #109)。UserScript は描かない。

- 列が週 (日曜始まり)、行が曜日の 7 行、直近 53 週分。左端と右端の列は欠ける
  - 開始日は `today − 7 × (weeks − 1)`。**マス数は曜日によらず 7 × (weeks − 1) + 1** (53 週で 365)。
    今日の列が右端で、今日より後と開始日より前のマスは描かない
  - **日付は UTC だけで計算する。** jsdom はマシンのタイムゾーンで動き、CI は UTC なので、
    ローカル時刻の API を使うと食い違いを検出できない
- セル 11×11px、gap 3px、`rx="2"` 程度
- 月ラベルを上部に、曜日ラベルを左に。**日本語** (`1月`、`日 月 火 水 木 金 土`)
  - **曜日は 7 行すべてに出す** (2026-09-15)。一つ飛ばしにするのは英語の
    `Mon` / `Wed` / `Fri` が行の高さに対して幅を取るからで、1 文字の日本語なら全曜日が並ぶ
  - 月ラベルは固定の配列から出す (`toLocaleString` を使わない)
  - **月ラベルはその月が始まる列にだけ出す** (2026-09-16 改訂)。列の最初のマスが月の 1〜7 日なら、
    その月はその週から始まっている (日曜始まりなので、通常の列では月の最初の日曜)
    - **左端の欠けた列は、月の途中から始まっていれば出さない。** 365 日は 12 か月より少し長いので、
      同じ月が右端でもう一度始まることがある。左端に出すと、その月が実際に始まる右端に出なくなる
    - **右端はラベルの幅ぶん空いているときだけ出す** (「9月」は約 14px で 1 列、「10月」は約 19px で 2 列)。
      右端の列に「10月」を置くと SVG の外へはみ出す
    - 月ラベル同士は最短でも 4 列離れる (最も短い月で 28 日) ので、間隔は見ない
  - 外部フォントは読めないので OS の日本語フォントを並べ、最後に `sans-serif`
- **`width` / `height` / `viewBox` の 3 つを必ず出力する。** Cosense で表示するのに必要
- **`<img>` 内の SVG は完全に非インタラクティブ。** `<title>` のツールチップも出ず、外部フォントも
  外部 CSS も読めない。すべてインラインで自己完結させる。
  **草はすべてこの形で見せるので、分数の内訳を出す手段は無い** (ADR-0019)
- **凡例は必須。** 2 次元エンコーディングは凡例なしでは意味を復元できない
  - **格子の下に右寄せで置く。** 右に置くと幅が増え、Cosense の本文幅で縮小される
    (53 週で 870px 対 775px)。全体の幅は格子と「プロジェクト名 + 凡例」の大きい方
  - ~~**4 行 = Level 1〜4、列 = 配色が持つバランスの見本** (2026-09-13 改訂、ADR-0016)。~~
    **2026-09-23 に 1 行 2 本の帯へ改訂した** (ADR-0016 の改訂、Issue #133)。4 行 × 5 列は格子の下に 65px の高さを取り、
    左はプロジェクト名 1 行だけなので画像の下 1/3 が空白になっていた。**2 つの軸それぞれの見本があれば意味は復元できる**
    - 量の帯 `少ない ■■■■ 多い`: Level 1〜4、バランス 0 (中央の列) の色
    - 読み書きの帯 `読む ■■■■■ 書く`: 配色が持つバランスの見本を Level 3 で塗る (ライトの Level 4 は暗く、色相の違いが読みにくい)。
      列の数は配色が決める (`violet-amber` は 5 列で −1 / −0.4 / 0 / 0.4 / 1)
    - 高さは 200 → **146**。53 週の幅は 775 のまま
  - `mode=write` はバランスが 0 の 1 列になるので、**量の帯だけ**
  - **週数が少なくプロジェクト名と凡例が重なるときだけ横に広げる。** 名前の幅は 1 文字 6.5px で見積もる
    (太字 9px の数字の実測 6.4px。2026-09-23、Hiragino Sans)。上限の 64 文字でも 53 週の幅に収まる
- 背景は両テーマとも透明。文字色だけテーマで変える (埋め込み側がテーマを選ぶ前提)
- ダークモードは `?theme=dark` で出し分ける。`prefers-color-scheme` は使えない
- **プロジェクト名は出さない。** サーバが持っていないので推測で書かない

### 活動の概観 (`overview.svg`)

**ADR-0021。2026-09-26、#153。** 草と同じく「layout → 文字列」に分け (`src/worker/graph/overview.ts` → `src/worker/overview-svg.ts`)、`width` / `height` / `viewBox` の 3 つを出す。

- **配置は GitHub と同じ十字** (research §8)。上 関わる / 右 読む / 下 作る / 左 育てる
- **長さは「値 ÷ 4 軸の最大値」の平方根。** 最大の軸が端に届く。GitHub は線形だが、それでは最大の軸 (多くは 読む) の数 % の軸が中心近くの点に潰れるので変えた (ADR-0021 の 2026-09-26 の改訂、#169)。面積がおおむね値に比例する。**% は時間の割合のまま**
- **% は合計が 100 になる整数。** 最大剰余法で丸める (切り捨てた後、端数の大きい軸から 1 ずつ足す。端数が同じなら上・右・下・左の順)。
  GitHub の丸め方は推定しかできず (research §8)、四捨五入では合計が 99 になる場合が残るので、必ず 100 になる方にした
- **0 の軸は % も頂点の円も出さず、頂点を中心に置く。** 軸名は出す。**全部 0 なら四角形を描かない** (十字と軸名だけ)。どちらも GitHub と同じ
- 図は四角形 1 つ。塗りと線は配色の量の帯の Level 3 (バランス 0) の色で、要素全体に `opacity` 0.5、線は太さ 7 で `stroke-linejoin="round"`
  (GitHub は `#40c463`)。0 でない軸の頂点に小さな円 (半径 3、中はライトで白・ダークで背景に近い黒、縁は四角形と同じ色)。十字は太さ 2 で端を丸める。
  **色は `graph/scheme.ts` から取り、`theme` と `palette` に従う**
- 軸名と % は軸の端の外側に置く (上は上、下は下、左は右寄せ、右は左寄せ)。日本語で `関わる 12%` の形 (% は太字)。フォントは草と同じ並びで、**大きさは 11px** (草の 9px はマスに合わせた大きさで、概観はマスが無いので読みやすさを優先した)
- 寸法: 幅 300 × 高さ 220、中心 (150, 110)、中心から端まで 70px。左の軸名 (`育てる 100%` で約 63px) が左端に収まる
- デモ (`/v1/g/demo/overview.svg`) は草のデモの日から書いた分の一部を作る・関わるに振り分けた固定の値で描く (`demoOverviewDays`)。**草のデモデータは変えない**
- 本文は `test/worker/overview-golden.test.ts` が SHA-256 で固定している (草と同じく、描画を変える PR は答えと証跡を更新する)
- 背景は透明で、文字と十字の色だけ `theme` で変える (草と同じ)

### カード (`card.svg`)

**ADR-0024。2026-10-07 に決め、#212 で実装した (#208)。** 草と同じく「layout → 文字列」に分ける (`src/worker/graph/card.ts` → `src/worker/card-svg.ts`)。
`width` / `height` / `viewBox` の 3 つを出す。形の根拠と却下した案は ADR-0024 決定 3。

- **500 × 400 (5:4)。** ページカードのサムネの枠 (広い画面で約 145 × 122) に合わせる (research §3)。カードでは 1 マスが約 4px でラベルは読めないので、
  ラベルはページの本文の表示 (高さ最大 300px) で読める大きさにする
- **カードでは下が切れうる** (タイトルが 2 行で 12%、3 行で 29%)。草と線を上に寄せ、名前の行を下端に置く
- 草: 正方形のマスで、列は週 (26 週)、行は曜日 (月〜日) × 時間帯 (朝 / 昼 / 夜) の 21 行。1 日は 3 マスを細い切れ目でつないだ縦長のタイルで、上下の角だけを丸める。
  日と日の間は縦横で均等に空ける
- マスの色は草と同じ (§7。濃さは量、色合いは読み書きの釣り合い)。四分位とバランスの中心は `*` の行の時間帯ごとの値から取る。
  **空きマスは朝 → 昼 → 夜の順に灰色が少しずつ濃くなる**。区間が NULL の日は合計の色を 3 マスに薄く塗る
- 左に曜日 (土日は一段淡く)、上に月 (淡く)。右端に「計」の列を置き、曜日 × 時間帯ごとの期間の合計を灰色の濃淡のタイルで示す
- **4 軸は草の下の 1 本の線。** 草の左端から「計」の列の右端までを「作る / 育てる / 関わる / 読む」の 4 区間に割合で分ける (無段階)。区間の間は小さく空け、
  色は 4 段階の灰色 (ダークでは濃淡を逆にする)。軸の名前は各区間の左端の下にごく小さく淡く置き、幅が足りなければ省く。
  0 分の軸は区間を作らず、すべて 0 なら淡い 1 本の線だけ。値は概観と同じ式 (§6)
- 名前の行: 左から `/プロジェクト名` (太字、`<a href>` を持つ)・丸く切り抜いたアイコン・ユーザー名 (控えめ、`@` なし)。
  合算は `layoutMark` の印とユーザー名だけ (アイコンは入れない)。**時間帯の凡例は置かない**
- ラベルの文言は `ja` / `en` の表で持つ (`lang`)。英語の軸名はトップページ (`site.ts`) と同じ Create / Grow / Engage / Read、計は Sum、曜日は Mon..Sun。背景は透明で、色は `theme` で変える
- 部品は草と概観のものを使う (`scale.ts`・`balance.ts`・`scheme.ts`・`overview.ts` の `sumOverview`・`layout.ts` の `FONT_FAMILY` / `TEXT_COLOR` / `layoutMark`・`svg.ts` の `escapeXml`)

---

## 9. UserScript

### 導入

ユーザーページ (`/{project}/{username}`) に1行。

```
code:script.js
 import "/api/code/cosense-grass/v1/script.js"
```

外部ドメインからの import は成立しない (ADR-0005)。バンドルは Cosense の公開プロジェクト `/cosense-grass` に置く。
ページは版ごとに分け、リリース版は `v1`、`v2`…、開発版は `dev` (ADR-0005 の 2026-09-14 の改訂)。

**複数プロジェクトで使うなら、各プロジェクトの自分のページに同じ 1 行を書く。**
サインインは 1 回で済み、どのプロジェクトから使っても同じ草になる。

### センサー

**段階 5 で実装した** (2026-09-14、`src/userscript/sensor.ts`、Issue #49)。

20 秒ごとに判定し、条件を満たせば現在の分の read bit を立てる。

- `document.visibilityState === "visible"`
- **`document.hasFocus()`。これは必須。** これがないと開きっぱなしのタブを全部数えて、
  ただのブラウザ起動時間計測になる
- 直近 3 分以内に操作があった (`scroll` / `wheel` / `mousemove` / `pointerdown` / `keydown` / `touchmove`)。
  UserScript を読み込む前の操作は見えないので、読み込んだ後の最初の操作から数える
- Layout が `page` / `list` / `stream` のどれか。Cosense が UserScript を読み直す条件と同じで、設定画面などは数えない

write は `scrapbox.on("lines:changed", ({by}) => ...)` の `by === "edit"` のときだけ立て、`scrapbox.Page.id` を
その日の編集したページに足す (ADR-0006)。`remote` は他ユーザー、`userscript` は自前、`navigation` はページ遷移。
**元に戻す / やり直しは `by` が `undefined` で、数えない** (research §2。取りこぼすのは undo だけの分)。

**数えるのは、自分のページに import の 1 行があるプロジェクトだけ** (ADR-0007 決定 5 の 2026-09-14 の改訂)。
配布モジュールは 1 ドキュメントで 1 回しか評価されず、アプリ内でどのプロジェクトへ移っても動き続ける (research §2 の常駐)。

- 評価したときのプロジェクトは導入済みとして数える
- 別のプロジェクトに入ったら、同一オリジンで `/api/code/<project>/<自分のユーザー名>/script.js` を 1 回読み、
  本文が `/api/code/cosense-grass/` を含むときだけ数える。結果はドキュメントの寿命の間だけ覚える
- 確かめている間と、読めなかったとき (メンバーでない・自分のページが無い) は数えない。通信の失敗は次に数えるときに確かめ直す
- 自分の別のページを経由して間接的に import していると数えない

**同じタブで 2 つ動かさない。** `dev` と `v1` を別々のプロジェクトで import すると、それぞれのモジュールが評価される。
`window[Symbol.for("cosense-grass.sensor")]` に動いているセンサーを置き、新しいセンサーは前のセンサーを止めてから始める。

新規ページ作成の検出では**プレースホルダーページをカウントしない**。
ポーリングのたびに**日付の変更も見る**。日を越えたら前日分を送る。

**書いたページの振り分け** (ADR-0021。2026-09-26、`src/userscript/sensor.ts`、#152)。§4 の 4 軸のために、書いた分を作る・関わる・育てるに分ける。

- そのページで最初の `edit` が来たら、同一オリジンの `/api/pages/v2/:project/:title` を 1 回引く (`fetchText` の依存注入を使う。タイトルは `scrapbox.Page.title`)。
  自分の id は `/api/users/me` をドキュメントの寿命に 1 回だけ引く
- `user.id` が自分でなければ関わる、自分で `created` のローカルの日付が書いた分の日と同じなら作る、それ以外は育てる (research §4 の実測)。
  **`persistent` は見ない** (保存の直後に問い合わせると true になる競合がある)
- 結果はページ ID でドキュメントの寿命の間だけ覚える。**プレースホルダーの ID が保存後に変わっても、もう 1 回引くだけ**
- `w` は今までどおりすぐに立てる。**判定が返るまでの分は控えておき、返ったら `c` か `o` に立てる** (育てるは何も立てない)。
  控えている間に日付が変わったら、分は書いた日のビットマップに立てる
- **判定できなければ立てない** (その分は育てるに入る)。失敗したページは次の `edit` で引き直す
- 作ると判定したページは、その日の `created` (ページ ID の集合) にも入れる。**これで `created` (新しく作ったページ数) も数えるようになった** (それまでは常に 0)
- 同じ分に種類の違うページへ書いたら、`c` と `o` の両方に立て、数えるときに作るを優先する (§9 の保存するもの)

### 保存するもの

| 場所 | キー | 内容 |
|---|---|---|
| IndexedDB | `cosense-grass` / `keys` / `device` | `{v, uid, kid, privateKey, publicKey, enrolledAt}`。秘密鍵は `CryptoKey` (`extractable: false`)、公開鍵は 65 バイトの raw |
| localStorage | `cosense-grass:bits` | 日 → プロジェクト名 → `{w, r, pages, created}`。w / r は base64url のビットマップ、pages / created はページ ID の配列。**今日と前の 29 日**。**v2 で `c` / `o` (ビットマップ) と `links` を足す** (下) |
| ~~localStorage~~ | ~~`cosense-grass:daily`~~ | **1.1.0 で廃止** (ADR-0019)。読むのはローカル描画だけだったので、持つ理由が無くなった。残っているものは `sweep` が消す |
| localStorage | `cosense-grass:sent` | `{v: 1, days: {日: {e: 送れたエントリのダイジェスト, n: 当日の送信回数}}, failure?, last?}`。今日と前の 29 日 (2026-09-15、Issue #67) |
| localStorage | `cosense-grass:settings` | `{v: 1, countRead}`。read 計上の on/off (2026-09-15、`src/userscript/settings-store.ts`、Issue #79) |

**プロジェクト名はローカルだけに持つ。** サーバへ送るのは `ph` だけ。

**uid と kid は localStorage に分けず、鍵と同じ IndexedDB のレコードに持つ** (2026-09-15、`src/userscript/keys.ts`、Issue #61)。
当初は IndexedDB に鍵、localStorage に uid と kid だったが、片方だけ消えると食い違う (鍵が無いのに uid がある、など)。
記録の疎通確認 (Issue #36) が同じ DB と store のキー `trial` を使っていたので、キーは `device` にして `trial` は読まない。
**知らない版のレコードは上書きしない** (`store.ts` と同じ約束)。

**`bits` は段階 5 で実装した** (`daily` も同時に入れ、1.1.0 で廃止した。2026-09-14、`src/userscript/store.ts`、Issue #49)。当初の表から次を変えた。

- **キーは ph ではなくプロジェクト名。** ph は uid でソルトするが、サインイン前は uid が無く、別のアカウントでサインインし直せば
  変わる。ph は送る直前に導く。当初あった `projects` (ph → プロジェクト名) の表は要らなくなった
- **合算 `*` はビットマップに持たない。** 読むときに各行の OR から数える。別に書くと食い違いうる。
  pages / created は ID の和集合から数える
- **持つのは送れる範囲だけ** (1.1.0、ADR-0019)。30 日より古い日は `sweep` が消す。
  1.0.0 までは集計値に畳んで 371 日持っていたが、読むのはローカル描画だけだった
- **書くたびに読み直す。** 別のタブと localStorage を共有するので、読む → OR → 書くを同期の 1 区間で済ませる。
  分の bit やページ ID が既に入っていれば書かない
- 値は `{"v": 1, "days": ...}`。**知らない版の記録があれば書かない** (新しい版のバンドルが別のタブで書いた形を壊さない)
- **v2 (ADR-0021、2026-09-26、#151)。** 各行に `c` (作る) と `o` (関わる) の base64url のビットマップを足した (`links` は #155 で足す)。
  `c` と `o` は `w` の部分集合。**同じ分に両方が立ちうる** (別のプロジェクトの行や、振り分けが後から変わった分) が、数えるときに作るを優先する
  (`o & ~c`。合算も OR してから同じく数える)。`links` は 1 日の中で (ページ ID, リンク先のハッシュ) の組で重複を除く集合で、
  リンク先の名前は持たない (#155)。**v1 の記録は捨てずに読み、次の書き込みで v2 にする** (`c` / `o` を空として読むだけで済む)。
  配布ページの import を `v1` から `dev` に切り替えても、未送信の記録を失わない。v2 を書いた後は、同じブラウザの v1 のバンドルは
  「知らない版」として書かなくなる (上の約束どおり)

localStorage はオリジン単位なので、**別プロジェクトのタブとも共有される**。
IndexedDB も同様なので、同じブラウザなら鍵は 1 つで足りる。

### 送信

定期送信はしない。書き込み回数は送信回数にほぼ比例するので、これが D1 の予算に直接効く。

| トリガ | 動作 |
|---|---|
| ロード時 | 未送信の過去日 (前日以前) をまとめて送る。これが主経路 |
| 日付の変更を検出 | 前日分を送る。タブを閉じずに日を越えるケースのため |
| `visibilitychange` (hidden) | 当日分を送る。**変化があり、かつ当日の送信回数が 4 回未満のときだけ** |
| 登録の成功 (2026-09-15 追加) | 未送信の過去日と当日分。登録する前に貯まっていた記録 (最大 29 日分) も送る |
| **「今すぐ送る」** (2026-09-15 追加、Issue #102) | 未送信の過去日と当日分。**人が押したときだけ**。当日の上限は自動と共有し、抑制は免れる (ADR-0010 の改訂) |

上限に達した後の活動は翌日のロード時か日付変更時に送られる。OR なので失われない。

**実装した** (2026-09-15、`src/userscript/outbox.ts` と `sender.ts`、Issue #67)。表から決めた・変えたところ。

- **過去の未送信の日は、どのきっかけでも送る。** 今日を送るのは隠したとき・登録の成功・「今すぐ送る」のとき (`includesToday`)
- **手動 (`manual`) は抑制を免れ、失敗しても `failure.n` を増やさない** (2026-09-15、Issue #102)。
  押したら 1 回は試す。増やすと「送れないから押し直す」が自動の送信まで指数的に止める (5 回で 4 時間)
- **送信済みは、uid を混ぜたエントリごとのダイジェストで覚える** (`cosense-grass:sent`)。変わったプロジェクトと `*` だけを送り直す。
  kid は混ぜない (D1 の行は uid ごと)。別のアカウントに入り直したら同じ中身も送り直す
- **当日の送信回数は、当日分を含む送信を始めた回数で、失敗も数える** (書き込み予算の上限を保つ)。最小間隔は設けない (持ち主の判断。値は段階 7)
- **1 回の実行は Web Locks (`cosense-grass:send`) の中で直列にする。** 当初の「localStorage のロックで 10 秒」から変えた。
  待った側は送信済みを読み直すので同じ中身を 2 回送らず、タブを閉じればロックは解ける。Web Locks が無ければロック無しで走らせる (OR なので無害)
- **画像にならない・応答が無い・幅が想定外なら、そこで打ち切って送信済みにしない。** 続けて失敗したら、自動のきっかけでは
  `min(15 分 × 2^(n−1), 24 時間)` 送らない (同じ 400 を送り続けない)。登録の成功で解除する
- **鍵はきっかけのたびに IndexedDB から読み直す。** 未登録なら送らず、コンソールに読み込みごとに 1 回だけ知らせる
  (段階 8 の設定 UI までは、自動でダイアログを出さない)
- ログに uid・ph・kid・URL・プロジェクト名・例外のメッセージを出さない (`formatEntries` の例外のメッセージは ph を含む)
- 送信の疎通確認 (Issue #31) の、タブを隠したときの自動送信は消した。**メニューも v1 を配るのに合わせて消した** (Issue #95)

**ロード時とタブを隠したときの自動送信は、署名つきの記録で成り立つことを確かめた** (2026-09-14、Chrome、Service Worker の制御外と
制御下の両方。research §2)。日付の変更をきっかけにした送信はまだ試していない。

- **ローカルの今日から 29 日より古い日は送らない** (2026-09-14 追加)。Worker は 30 日より古い日を含むリクエストを
  丸ごと 400 にするので、混ざると同じ URL を永久に再送することになる。時差の余裕で 1 日短くする
- 応答の GIF の幅が 17 なら書いた、16 なら変化なし (§6)。どちらも送信済みとして扱う
- `img.referrerPolicy = "no-referrer"` を `src` より前に設定する。**ただし Cosense の Service Worker がページを
  制御していると作り直されるので、Referer にオリジンだけ (`https://scrapbox.io/`) が届く** (ADR-0001 の 2026-09-14 の改訂)
- Worker は Referer でも `Sec-Fetch-Dest` でも判定しない。Service Worker の制御の有無で値が変わる
- URL が 8KB を超えるなら日を分割して複数回送る。**実装は 14 エントリずつに分ける。** 最悪の 14 件でもエンコード後 8,000 文字以下になることをテストで固定した
- ~~複数タブの重複は localStorage のロックで 10 秒抑制する程度でよい。~~ Web Locks にした (上)。OR なので重複送信は無害
- 送信前に鍵で署名する。鍵が読めなければサインインを促す

### 表示

**ページメニューに足すのは 1 項目だけ** (2026-09-15、Issue #95)。ほかのスクリプトと並ぶ場所なので占有を最小にする。
**名乗りは `cosense-grass`** (2026-09-15、Issue #101)。**動詞で名乗らない** — ここは草を見るだけの場所ではなく、
設定へ行く入口でもある。ほかのスクリプトの項目と並ぶので、どのスクリプトのものかが分かる名前にする。
「設定」はそのダイアログの下のボタンから開く。**ダイアログは `<dialog>` で開く** (ADR-0003 の 2026-09-15 の改訂)。

**各囲みの草の下に活動の概観を置く** (2026-09-26、ADR-0021、#154)。合算にもプロジェクト別にも、草と同じ publicId の
`/v1/g/{publicId}/overview.svg` を 300 × 220 で先に確保して `<img>` で出す。**読めなければ何も出さない** (読めない理由は草の側で言う)。
「今すぐ送る」の後は草と一緒に取り直す。`/account` の合算の草と、トップのデモの草の下にも並べる。

**囲みの中の配置** (2026-09-26、#164)。草の下を `flex-wrap` の 1 行にし、左に概観、右に「共有する」の欄を置く
(概観を左寄せで置くだけだと、草の幅の右側 約 460px が空いていた)。狭い画面では欄が概観の下へ折り返す。

- 「共有する」の欄は、草・活動の概観・日ごとの数値 (JSON) の 3 行で、どれにも「URL をコピー」を置く。名前の列は格子でそろえる。
  JSON にだけ「開く」(別のタブ、`rel="noopener noreferrer"`) と、渡すと内訳まで読める旨の注意を添える (ADR-0020 の改訂)
- ボタンの文言は短いままにし、何の URL かは `aria-label` で名乗る (「{見出し} の活動の概観の URL をコピー」など)
- コピーできなければ、その行の中に選んでコピーできる欄を出す (従来どおり)

**冒頭に、畳んだ説明「草と活動の概観の見方」を置く** (`<details>`、#164)。数える単位 (分、書いた・読んだの判定)、草の色の決め方
(四分位と中央値)、活動の概観の 4 軸、送るものを短く書き、プライバシーポリシーへリンクする。**数値は実装と合わせる**
(3 分・20 秒は `sensor.ts`、3 分のデッドゾーンと四分位は §7)。理由の文言だけのとき (未登録など) にも出す。
**見出しは開けることが分かる帯にする** (#170)。素の `summary` は既定の小さな三角しか手がかりが無く、気付かれにくかった。
背景でボタンらしくし、左に「?」、右端に「開く / 閉じる」と、開くと 90° 回る山形を置く (`toggle` で切り替える。飾りは `aria-hidden`)。
**枠は見出しでなく `<details>` 全体に付け、開いたときは見出しと本文を 1 つの囲みにする** (#173)。見出しの下の区切り線は開いているときだけ引く。本文が枠なしで続くと、どこまでが説明か分からなかった。
Safari の既定の三角は `::-webkit-details-marker` でしか消せないので、`<details>` の中に範囲を絞った `<style>` を 1 つ置く。
**「数えているもの」「草」「活動の概観」の節の先頭に、具体例に注釈を付けた図を置く** (#182)。文章だけでは 1 分ごとの記録・
濃さ × 色合いの 2 次元の色・4 軸の形が絵にならなかった。図は Worker の `/v1/guide/{name}.svg` を `<img>` で貼る (§6。ADR-0019)。
幅と高さを先に確保し、狭い画面では縦横比を保って縮める。**畳んだ説明を開くまで取りに行かない** (`loading="lazy"`)。
図が読めなくても要点が伝わるよう `alt` に 1 文で書き、**数値の定義 (四分位・3 分・20 秒・平方根・丸め) は本文にも残す**。

**説明欄の下に「期間」を置き、過去の年の草と活動の概観を見てコピーできるようにする** (#177)。

- 選択肢は「直近 1 年」と、去年から 2026 年 (`FIRST_YEAR`。Worker が記録を受け始めた年) までの各年。選ぶと、すべての囲みの草と概観を `?year=YYYY` 付きで読み直し (読めてから差し替え、読めなければ文言にする)、「URL をコピー」も同じ URL をコピーする。送った後の取り直しも選んでいる年で行う
- **今年は並べない。** `?year=` は右端を今日に落として 53 週を遡るので、今年を選ぶと直近 1 年と同じ絵になる。**過去の年が無いあいだ (2026 年中) は欄ごと出さない**
- 日ごとの数値 (JSON) は全期間なので期間を付けない。開くたびに直近 1 年へ戻す (覚えない)

**枠とボタンは Cosense (Bootstrap 3 系) の見た目に合わせる** (#175、`dialog.ts` の `styleDialog`)。草・設定・サインインの 3 つのダイアログで共通。

- 枠は `.modal-content` の値 (枠 `1px solid rgba(0,0,0,.2)`・角丸 6px・影 `0 3px 9px rgba(0,0,0,.5)`・白地に `#333`)。ボタンは `.btn-default.btn-sm` の値 (白地・枠 `#ccc`・角丸 3px・12px)。2026-09-27 に Cosense の計算値を読んで確かめた
- **Cosense のクラスは借りず、同じ値を自前で持つ。** 借りると Cosense の CSS の変更で崩れ、Cosense の外で見た目を確かめられない
- `:hover`・`:focus-visible`・`::backdrop` はインラインの style で書けないので、`[data-cosense-grass-dialog]` に範囲を絞った `<style>` を 1 つダイアログの先頭に置く
- 暗幕は Cosense の 0.8 より薄い 0.5 (Bootstrap の既定)。開いた元のページが透けて見える方が文脈を失わない
- 「URL をコピー」はコピーのアイコン付きで、できたら 2 秒だけチェックと緑 (`#1a7f37`) にして戻す。**文言と `aria-label` は変えない**。JSON の「開く」はリンクのまま同じボタンの見た目にし、外部リンクのアイコンを付ける

**下端の行は、左に「設定」、右に配布ページ (Cosense)・ソースコード (GitHub)・プライバシーポリシーへのリンク** (#164)。
URL は `src/shared/links.ts` に置き、Worker のトップと共用する。開いたときのフォーカスはダイアログそのものに置く
(既定では最初の操作できる要素、つまり説明の見出しに当たって枠が出る)。

**出すのは全端末を統合した草だけ** (1.1.0、ADR-0019、Issue #109)。共有 SVG を `img` で埋め込む。
**UserScript は草を描かない。**

当初は「このブラウザの記録」を localStorage から描いて並べていた (#73)。同じ形の草が 2 つあると
値の食い違いがどちらも本当に見えるので #101 で `<details>` に畳み、1.1.0 で撤去した。
**未登録のブラウザでは草が 1 枚も出ない** ので、活動はすでに数えていることを文言で伝える。

**合算の草の直後に、同期の状態と「今すぐ送る」を置く** (2026-09-15、`viewer.ts` の `describeSync`、Issue #102)。
2 つが違う値になる理由を、絵の隣で説明するもの。

- **分かるのは「このブラウザから送信済みか」だけ。** サーバには問い合わせられない (ADR-0001)
- **前日以前と今日を分ける。** 今日を送るのは隠したときと登録直後だけなので、開いた瞬間の今日はほぼ常に未送信。
  混ぜると開くたびに「未送信あり」が出て、警告として効かなくなる。前日以前の未送信はほぼ異常
  (送信の失敗・抑制中・登録前の溜まり・保存領域) なので、こちらだけ日数を出す
- **`last` は「最後に送った」ではなく「最後に試した」。** 結果を問わず書かれるので `outcome` で言い分ける。
  今日でなければ日付も出す (「09:05」だけでは昨日か今日か分からない)
- **自動で送っていることを必ず添える。** これが読めれば「今すぐ送る」は非常用だと分かる
- ボタンを押せるのは「前日以前の未送信がある **または** 今日が未送信で上限未満」のとき。
  **上限だけで塞がない** (上限に達していても前日以前は送れる)
- 押している間はボタンを無効にして「送っています…」を出す。本番のロックにタイムアウトが無く、
  画像の待ちは 15 秒 × 最大 5 本なので**最悪 1 分以上待つ**
- 押した後は**ダイアログを開き直さない。** 開き直すと畳みが戻り、統合の画像を全部取り直す。
  状態行と、送れたときだけ表示中の画像を差し替える

~~ツールチップは `2026-09-12 — 書き 12 分 / 読み 38 分 / 7 ページ編集 / 2 ページ新規作成` の形。
2 次元表示では色の絶対的な意味が読めないので、DOM 注入版では必ず出す。~~
**1.1.0 で無くなった** (ADR-0019)。`<img>` の SVG では `<title>` が出ないので、
**分数の内訳を見る手段は当面ない**。必要になったら `/account` に出す。

~~テーマは `document.documentElement` から判定する。
`page:changed` / `layout:changed` で再マウントと後片付けをする。~~
**草は常にライトで出し、再マウントはしない** (2026-09-15、ADR-0003 の改訂)。素の `<dialog>` はどのテーマでも白く、
ページに挿さないので遷移で消えない。

**統合された記録を先に入れた** (2026-09-15、`src/userscript/viewer.ts`・`graph-dialog.ts`、Issue #73)。

- 草の URL は `sender.status()` の値をそのまま使う (publicId の導き方を 2 か所に書かない)。未登録・新しい版の鍵・保存領域を開けないときは理由だけを出す
- 並びは合算、今のプロジェクト、残りは名前の順。**並ぶのはこのブラウザで直近 30 日に記録したプロジェクトだけ**
  (サーバはプロジェクト名を持たない。ADR-0007)。今のプロジェクトも記録が無ければ出さない (未導入のプロジェクトでも UserScript は動き続ける。research §2)
- **このブラウザから 1 件も送れていないものは、「表示してみる」を押すまで画像を読まない。** 404 のリクエストを出さず、
  URL をコンソールのエラーに残さない。ほかの端末から送っていれば草はあるので、押せば見られる。
  **合算も同じ扱いにした** (2026-09-15、Issue #100)。当初は合算だけ「送れている」と決め打ちしていたので、
  登録しただけでまだ送っていないブラウザでは、主役の位置に 404 の絵が出ていた。
  判定は `sender.status()` の `totalSent` (合算の行 `*` のダイジェストが送信済みにあるか)
  - **2026-09-24 に撤去し、最初から読むようにした。** 押す手間の方が煩わしかった。代わりに、読めなかったときの文言を
    送れたかどうかで言い分ける (送れていなければ「まだ送っていません。ほかの端末からも送っていなければ、草はまだありません」)。
    **失うもの:** 未送信でほかの端末からも送っていないと 404 のリクエストが出て、ブラウザがその URL を
    コンソールのエラーに出しうる。自分のブラウザのコンソールなので受け入れる (このコードは URL を出さない)
- プロジェクト別は 5 件まで出し、残りは押すと出す。開くたびの Worker へのリクエストと D1 の読み取りを抑える
- 画像が読めなければ文言に置き換える。`<img>` は `loading="lazy"`、`referrerpolicy="no-referrer"`、775×146 を先に確保する (2026-09-23 に 200 から改訂。Issue #133)
- 「URL をコピー」はクリックの処理から `await` を挟まずに `navigator.clipboard.writeText` を呼ぶ (Safari はユーザー操作の直後でないと拒む)。
  失敗したら選んでコピーできる欄に出す
- キー入力・貼り付けに加えて `copy` / `cut` もダイアログの外へ伝えない (Cosense のコピーの処理に拾わせない)
- **閉じるのは外側のクリックと Esc** (2026-09-24、`src/userscript/dialog.ts`)。「閉じる」ボタンは撤去した
  (設定のダイアログも同じ)。背景のクリックは「target が `<dialog>` 自身で、位置がその矩形の外」で見分け、
  **押した位置も背景のときだけ閉じる** (中の文字を選んだまま外で離しても閉じない)。`closedby="any"` はブラウザの対応が
  揃っていないので使わない。**サインインのダイアログは変えない** — 登録の途中の誤クリックで流れが中断されるため

**このブラウザの記録は 1.1.0 で撤去した** (ADR-0019、Issue #109)。`render.ts` と
`viewer.ts` の `describeLocal` が、`layoutGraph` の入力を localStorage から作って DOM の SVG に
していた。撤去して失うのは、マスのツールチップ・未登録での表示・送信前の反映の 3 つ
(いずれも ADR-0019 の帰結に書いた)。

**カードの図もダイアログから見て、貼る行を取り直せるようにする** (ADR-0024・0025。段階 10 で実装した、#208)。

- 各囲みの「共有する」の欄に「カード」の行を足した (草・活動の概観の次、JSON の前)
- プロジェクト別の囲みは、図 (`/v1/g/{publicId}/card.svg`) を **250 × 200 (図の半分)** で出し、その下に「Cosense に貼る行をコピー」を置く。
  図は概観と同じく遅延読み込みで Referer を送らず、読めなければ図だけを消す。**期間では読み直さない** (図は直近 26 週で決まっている) が、「今すぐ送る」の後の取り直しはする
- 合算の囲みはコピーだけを出す (合算のカードはプロフィールページに貼らない)
- コピーするのはリンク付きの画像の行 (下の「プロフィールへの自動挿入」と同じ形。`worker-origin.ts` の `cardLine`)。既存の `copyLine` を使い、
  ボタンの `aria-label` は「{見出し} のカードの Cosense に貼る行をコピー」
- 畳んだ説明に「カードと自分のページ」の節を足し、自動で貼ること・消しても貼り直すこと・止め方 (import の 1 行を外す) を書いた

### プロフィールへの自動挿入

**ADR-0025。2026-10-07 に決め、段階 10 で実装した (#208。`src/userscript/profile.ts`・`cosense-socket.ts`)。実機での commit の受理は未確認** (research §7)。
UserScript が、導入したプロジェクトのプロフィールページ (自分のユーザー名のページ) に、そのプロジェクトのカードの図の行を貼り続ける。
**UserScript がページに書く初めての機能。**

- **動く条件**: 登録済み・Cosense にログイン済み・そのプロジェクトに導入済み (import の 1 行がある。上の「センサー」と同じ判定)
- **きっかけ**: 読み込み時の送信 (`sender.trigger("load")`) の後と、登録に成功した後
- **確かめ方**: 同一オリジンの REST でプロフィールページを読み、そのプロジェクトの publicId を含む `…/card.svg` の行があるかを見る。
  判定は `grass.soui.dev` / `cosense-grass.soui.workers.dev` の図の URL のパターンで、完全一致にしない。あれば何もしない (普段は GET 1 回で終わる)
- **無ければ貼る。** 位置は cosense-grass を読み込むコードブロックの最後の行の直後。無ければ最下部。**最上部には置かない**。
  利用者が動かした行は戻さず、消したら次に開いたときに貼り直す
- 行はリンク付きの画像:

  ```
  [https://grass.soui.dev/v1/g/<publicId>/card.svg?l=<project>&u=<user> https://scrapbox.io/<project>/]
  ```

- **経路は同一オリジンの WebSocket** (`wss://scrapbox.io/socket.io/`、research §1・§4)。ライブラリを使わず、ネイティブの `WebSocket` の上に
  Engine.IO v4 / socket.io v5 の最小限を書く (`src/userscript/cosense-socket.ts`)。`0` → `40` → `42<ack>` (socket.io-request の `commit`) → `43<ack>`。
  ping (`2`) に pong (`3`) を返し、タイムアウトを付け、終わったら閉じる。`WebSocket` は注入してテストでは偽物にする
- commit は `_insert` 1 つと、メタデータ (`linesCount` / `charsCount` / `image` / `descriptions`) の差分。`pageId` / 直前の commit / 行の id / `projectId` / `userId` は REST で引く
- **不変条件: insert だけを送り、update と delete は送らない。コードブロックの中に入れない** (入ると script.js が変わり、SHA1 の承認ゲートで UserScript が止まる。research §2)。テストで守る
- **二重貼りの防止**: `parentId` が古ければ (`NotFastForwardError`) 読み直して確かめ直す (最大 3 回)。同じブラウザのタブどうしは `navigator.locks` で直列にする
- **センサーは変えない。** 別の接続からの commit は開いているタブに `by: "remote"` で届き、センサーは `edit` だけを数える (ADR-0006)
- publicId は `phOf` / `publicIdOf` で導き、`sender.ts` の status と同じ関数を使う (導き方を 2 か所に書かない。`worker-origin.ts` の `graphIds`)

**実装で決めたこと** (2026-10-07)。commit とメタデータの形は `@cosense/std` の `websocket/push.ts`・`diffToChanges.ts`・`id.ts`・`makeChanges.ts`・
`getPageMetadataFromLines.ts`、行のまとまりは `@progfay/scrapbox-parser` の `block/Pack.ts` を読んで合わせた (出典はコードのコメント)。

- **導入の判定は `index.ts` が持つ。** センサーの `status()` が `counting` のときだけ `profile.ts` を呼ぶ。読み込んだプロジェクトは導入済みで、
  移った先で登録したときは、確かめ終わる (`checking` が終わる) までは呼ばない (次に開いたときに確かめる)
- **1 回のページ読み込みで、1 つのプロジェクトにつき 1 回だけ確かめる。** 未登録・未ログインで飛ばしたときは数えない (登録の後に確かめる)。失敗しても同じ読み込みでは試し直さない
- **ページを作らない。** `/api/pages/:project/:user` が 404 か `persistent: false` なら何もしない。読むときはキャッシュを使わない (`cache: "no-store"`)
- **判定はオリジンを見ない** (ADR-0025 の改訂)。行のどこかに `/v1/g/<publicId>/card.svg` があれば貼らない。コードブロックの中にあっても「ある」とする
- **足す位置**: `code:` で始まり、それより深く字下げされた行のどれかが `/api/code/cosense-grass/` を含むブロックの最後の行の次 (`_insert` はその次の行の id、末尾なら `_end`)。
  無ければ末尾。**ページがタイトルの 1 行だけなら足さない** (末尾がタイトルの直後になる)。行は字下げしないので、どのブロックにも入らない
- **行の id** は `createNewLineId` と同じ形 (秒の 16 進 8 桁 + userId の末尾 6 桁 + `0000` + 乱数の 16 進 8 桁)
- **メタデータの差分**: 行を 1 つ足して変わりうるのは `image` / `descriptions` / `linesCount` / `charsCount` だけ (リンク・アイコン・ファイル・helpfeel・infobox は増えない)。
  `linesCount` と `charsCount` (コードポイントで数える。タイトルも含む) は必ず入れる。
  `image` は、画像の無いページか、今の画像の行が足す位置より後ろにあるときだけカードの図にする。**今の画像の行を本文の中で見つけられなければ変えない** (誤ってサムネを差し替えない)。
  `descriptions` は、足す位置より前の説明 (中身のある行とコードブロック。空行とテーブルは数えない) が 5 つ未満のときだけ、その位置に入れて 5 つに切る
- **送り方**: commit 1 つにつき接続を 1 本開き、応答 (か 20 秒のタイムアウト) で閉じる。ack の番号は 0 に固定。`room:join` は送らない (`@cosense/std` の `push.ts` も送っていない)
- **ログ**: 貼れたら `console.info`、貼れなければ理由の種類 (エラーの名前・`timeout` など) だけを `console.warn` に出す。URL・publicId・ページの中身は出さない

### 設定 UI

**「設定」のダイアログ** (2026-09-15、`src/userscript/settings.ts`・`settings-dialog.ts`、Issue #79。
名前は #101 で「草の設定」から縮めた。入れ子の「cosense-grass」→「設定」で十分に指せる)。
**入口は草のダイアログの下のボタン** (2026-09-15、Issue #95。それまではページメニューの独立した項目だった)。

**2026-09-17 の改訂 (Issue #122) — ページメニューの置き方を `addItem` から `addMenu` に変えた。**
ハンバーガーの中の項目ではなく、`div.page-menu` の**独立したボタン**にする。草を見るのに 2 クリック
要っていたのが 1 クリックになる。**占有は 1 つのままなので、#95 の「占有を最小に」は崩れていない。**
アイコン (`src/userscript/menu-icon.ts`) は data: URI の SVG で、**3 つの状態を絵で示す**。
絵は `src/shared/grass-icon.ts` が作り、Worker の favicon と共有する (2026-09-21、Issue #130)。

| アイコン | 状態 | 判定 |
|---|---|---|
| 点線の枠だけ | このプロジェクトでは数えていない | `sensor.status() === "not-installed"` |
| グレーのマス | 数えているが未サインイン | 数えている + `not-enrolled` |
| 青緑のマス | 送っている | 数えている + `enrolled` |

UserScript は一度読み込まれると全プロジェクトで常駐する (research §2) ので、**1 行を入れていない
プロジェクトでもボタンは出る。** 点線の枠は「出ているが数えていない」を示す。
`title` は tooltip であると同時にボタンの要素の `id` になるので、**状態で変えない**。
開く側は先に草のダイアログを閉じるので、2 枚重ならない。サインインは設定のダイアログの中のクリックで始まるため、
ポップアップを開く同期区間は分断されない。
**ここに置くのは、そのブラウザでしかできないことだけ** (ADR-0018、Issue #88)。
サーバのデータの管理 (端末の一覧・共有 URL・全削除) は `/account` で、ここからはリンクを出す。

- **Google でサインイン。** 未サインインなら最初にこれだけを出す
- **登録済みデバイスの一覧と失効ボタン。** 今のデバイスには印を付ける。
  **この端末の失効は済み** (2026-09-15、Issue #79)。確認を挟んでから `/v1/revoke.gif` を送り、ローカルの鍵も消す。
  **一覧はこのダイアログに出せない** — CSP に受信方向が無く、UserScript からサーバの `keys` を読めない (ADR-0001・0003)。
  この端末の kid はダイアログに出し、**ほかの端末の一覧と失効は Worker の `/auth/devices` で扱う** (ADR-0017)。
  ダイアログからはそのページへのリンクを出す。**済み** (2026-09-15、Issue #79)
- **草 1 件は枠で囲む** (2026-09-17、Issue #124)。見出し・画像・「URL をコピー」を 1 つの囲みに入れ、
  **枠の内側の余白 (12px) より枠と枠の間 (20px) を広く取る**。囲まずに縦へ並べると、コピーボタンが
  上の画像のものか下の画像のものか読み取れない (共通領域と近接の両方で示し、枠線が見えにくい環境でも
  間隔でまとまりが読めるようにする)。**「今すぐ送る」は囲まない** — 草ではなく全体に効く操作なので、
  囲むと合算だけの操作に見える
- 共有 URL の一覧。全体用とプロジェクト別をそれぞれコピーできる。**段階 8 までは「草: センサーの記録」の alert に出していた** (2026-09-15、Issue #67。そのメニューは #95 で消えた)。
  **草のダイアログでもコピーできる** (2026-09-15、Issue #73)。
  プロジェクト別の publicId は uid からしか導けず UserScript の中にしか無いので、このブラウザで直近 30 日に記録したプロジェクトを並べる。
  まだ 1 件も送れていないプロジェクトの URL は 404 になるのでそう添える
- read 計上の on/off。全体で 1 つ。プロジェクト単位にはしない。**済み** (2026-09-15、Issue #79)。
  off でも**書きは数える** (草が空になる方が分かりにくい)。センサーは数えるたびに設定を読み直すので、別のタブで変えても次の判定から効く。
  **知らない版の設定があるときは変えさせない**が、読む方は `countRead` を尊重する (数えないでほしい、という意思表示を版で覆さない)
- 全データの削除は**管理のページ (`/account`) が持つ** (ADR-0018)。設定 UI には
  「このブラウザの記録を消す」だけを置く (記録の 3 つのキー。**設定は残す**)

### 導入前の活動は遡らない

**バックフィルは実装しない** (ADR-0012)。`/api/commits` は最終更新から約 30 日で消えるので、
1000 ページを走査しても 1 か月分しか得られない。

導入直後は草が空になるので、**データが無いことと活動が無かったことを区別する印を出す**
(2026-09-15、`src/worker/graph/layout.ts`、Issue #80)。

- **計測開始 = 記録のある最も古い日。** 別に「導入日」を持たない (localStorage にも D1 にも無く、
  新しく持つと端末間でずれる)。`daily` の `ph = '*'` の全期間から取る。**プロジェクト別も合算の開始日で塗り分ける**
  (そのプロジェクトを使い始めた日ではなく、計測していなかった期間を示すため)
- **開始日より前のマスは塗らず、点線の枠だけにする。** 何も描かないと欠けて見え、Level 0 の塗りとも
  区別が付かない。枠の色は文字色より薄い `#d0d7de` / `#3d444d`
- **プロジェクトは凡例の行の左端に `scrapbox.io/<名前>` と太字で出し、同じ URL を `<a href>` に持たせる**
  (2026-09-18、Issue #119)。**ここに置くのは寸法を増やさないため** (下と同じ理由)。
  `<img>` で貼られている間はリンクを押せないが (research §3)、**画像そのものを開けば飛べる** (実測済み)
- **ユーザー名は同じ行に `@<名前>` と続ける** (2026-09-23、Issue #134)。リンクにはしない。
  位置を文字幅の見積もりで決めず、同じ `<text>` の `<tspan>` にしてブラウザに並べさせる。
  凡例と重ならないように取る幅はプロジェクト名と同じ見積もりに足す
  (両方が長いと 53 週でも幅が 775px を超え、`<img>` に寸法を固定した UserScript では少し縮む)
  - ~~太字にしない~~ **2026-09-24 に太字・濃い色 (`#1f2328` / `#e6edf3`) にした。** 灰色の細字では、
    太字のプロジェクト名の後ろで誰の草かが埋もれた
- **合算の草 (`ph = '*'`) は、名前の行の左端に草のマスを 3 枚ずらして重ねた印を置く** (2026-09-24)。
  **文字では示さない** — 「全プロジェクトの合算」と書くより、草の絵のまま「束ねた草」と読める方が
  画像の中で浮かない。ユーザー名はその右に続く。合算かどうかは publicId が決め、クエリでは指定しない
  (Cosense に貼られた合算の画像にも付く)。一辺は格子のマスと同じ 11px で、凡例の行の高さに収める。
  色はスキームの Level 1〜3 (量の帯と同じバランス 0) で、奥 (右上) ほど薄い。**白の縁取りは使わない** (ダークで浮く)。
  合算以外の草は SVG の本文が 1 バイトも変わらない (印のグループごと省く。ETag を変えない)
- ~~**ラベルは凡例の行の左に「点線は計測開始前」。**~~
  **2026-09-18 に注記の文字を消した** (Issue #119)。点線の枠だけで Level 0 の塗りとは区別が付き、
  凡例の行はプロジェクトの表示に使う。**点線の枠そのものは残す**
- 開始日が表示範囲より前なら印は出ない (全マスが計測済みなので区別する必要が無い)

---

## 10. 脅威モデル

### 守るもの

| 脅威 | 防ぎ方 |
|---|---|
| 共有 URL を知る人が書き込む | 署名が必要。公開鍵から秘密鍵は導出できない |
| **第三者が他人の識別子を計算する** | uid は Worker 固有の秘密で HMAC する。`sub` を知っていても計算できない |
| 運営者が他人の書き込み権を得る | 秘密鍵はデバイスから出ない。ログに流れるのは公開鍵と署名だけ |
| D1 の漏洩から書き込み権が漏れる | 保存するのは公開鍵だけ。登録トークンも SHA-256 だけを持つ |
| D1 の漏洩からプロジェクト名が漏れる | uid でソルトしたハッシュしか送らない |
| **D1 の漏洩から Google アカウントが特定される** | `sub` は保存せず HMAC の結果だけを持つ |
| プロジェクト別の共有 URL から全体や他を見る | 一方向導出 |
| 誰がいつ何を読んだかが漏れる | read イベントにページ識別子を一切載せない |
| 未来の草を生やす | `day` が未来なら拒否する |
| **被害者の端末を攻撃者の uid に登録させる** (ログイン CSRF) | state を署名付き cookie と結び付け、cookie を `__Host-` にして別のサブドメインから差し込ませない |
| 認可コードの横取り | PKCE (S256) と client secret。redirect_uri は設定値に固定 |

### 守らないもの

- **数字の正しさ。読みも書きも自己申告**で、サーバに検証手段がない。
  マウスを揺らすスクリプトで読みは無限に稼げる。**書きも Cosense と突き合わせていない。**
  ランキングなど競争的な用途に使わない理由がこれ
- D1 が漏洩したときの活動パターン。「毎日 23 時に活動している」は読める
- 分散した Google アカウントからの大量登録。ベストエフォート
- **`WORKER_SECRET` の喪失。** 失うと全ユーザーの uid が再計算できなくなる。バックアップが前提

### 受容する脆弱性

- `publicId` を知る人に日別活動量が見える。共有するかはユーザーの選択
- **JSON の URL (`publicId` と `dataKey`) を知る人には、日ごとの書いた分・読んだ分・ページ数まで見える** (ADR-0020)。
  草の URL からは作れないので、内訳を渡すかは草とは別に選べる
- **`publicId` を知る人には、直近 26 週の日ごとの時間帯の活動 (カードの図) も見える** (ADR-0024。#212 で実装)。
  **UserScript がプロフィールページに図を貼る** (ADR-0025) ので、公開プロジェクトではそのページを見る誰もが `publicId` を知る。
  JSON の URL は作れないのは変わらない
- **Worker が scrapbox.io へ外向きのリクエストを送る** (カードのアイコン、ADR-0024)。受け取った `l` / `u` から組み立てるが、
  取り先は scrapbox.io の 1 つの API に固定し、転送を辿る先も許可リストに限る。画像の種類と大きさを確かめ、SVG は埋め込まない
- **草のダイアログで開いた草の URL は、scrapbox.io の Cache Storage に 48 時間残る** (Cosense の Service Worker が画像を保存する。research §3)。
  同じオリジンで動くスクリプトから列挙できるが、それらは IndexedDB の鍵も使えるので、新しく増える露出は無い。
  UserScript のコードからは URL をコンソールにもログにも出さない
- デバイスの IndexedDB を読める攻撃者 (物理アクセスや深刻な XSS) は、そのデバイスから署名できる。
  ただし鍵を取り出して持ち出すことはできない
- **攻撃者のコードを貼らされる。** 攻撃者が自分でサインインして出したコードを「これを貼って」と渡すと、被害者の端末が
  攻撃者の uid に登録され、その後の送信の `ph` から、被害者がどのプロジェクトで活動しているかを攻撃者が辞書で推測できる。
  ダイアログに「自分でサインインして出たコードだけを貼る」と書き、結果に受け取った経路を出す
- **ポップアップ内のページは opener を動かせる。** opener が要るので `noopener` を付けられず、Google などのページは
  `opener.location` で Cosense のタブを移動させられる。使い終えたらポップアップを閉じて時間を短くする
- **表示したコードを騙し取るフィッシング。** 攻撃者のサイトが `/auth/start` をポップアップで開き、表示されたコードを貼らせれば、
  攻撃者が被害者の uid に鍵を登録できる。コードを表示する経路 (COOP のフォールバック) に付きまとう。
  画面に「Cosense の「cosense-grass」→「設定」にだけ貼る」と書き、5 分・1 回で使えなくなることで狭める
- **scrapbox.io の同じオリジンで動くスクリプト** (利用者が入れた他人の UserScript など) は postMessage を受け取れる。
  それらはどのみち IndexedDB の鍵も使えるので、新しく増える露出は無い

### DoS 対策

Free 枠で組める多層にする。

1. **独自ドメインに載せる。** `workers.dev` では zone の WAF が効かない
2. **WAF の rate limiting rule 1 本。** Free では IP のみ、period 10 秒のみ。粗い洪水を
   Workers 到達前に止める。ここでブロックされた分は日次リクエスト枠を消費しない
3. **Worker 内で Rate Limiting binding。** キーは IP ではなく uid にする
4. **署名検証を D1 アクセスより前に置く**
5. **route は fail closed にする。** 日次リクエスト上限を超えたとき fail open だと
   Worker 不在扱いになる
6. **Bot Fight Mode は OFF。** JS 実行を要求するチャレンジは画像ビーコンを静かに壊す

**Google サインインが新規 uid の大量生成を構造的に抑える。** 攻撃者は uid ごとに別の Google
アカウントを用意する必要があり、鍵ペアを作るのと違って無料ではない。公開提供でこれが一番効く。

---

## 11. 運用

### D1 Free の書き込み予算

1 日 2 プロジェクトで活動する人なら、1 回の送信で書くのは 3 エントリ (2 プロジェクト + 合算) ×
2 テーブルで 6 行。1 日の送信は前日分 1 回 + 当日分 4 回で最大 5 回。

**この回数はブラウザごと** (2026-09-15、Issue #67)。2 台で使えば 1 人あたり最大 10 回になる。受信方向が無い (ADR-0003) ので、
人ごとに抑える手段は無い。ただし変化の無いエントリは送らず、Worker も変化の無い行は書かない (§6) ので、実際の書き込みは活動した分に比例する。

| 送信頻度 | 1 人あたり 1 日 | Free 枠 10 万行での収容人数 |
|---|---|---|
| 10 分ごと (却下した案) | 288 行 | 347 人 |
| 1 時間ごと (却下した案) | 54 行 | 1,851 人 |
| **採用案 (1 日最大 5 回)** | **30 行** | **3,333 人** |

D1 Free の日次上限は 2026-09-01 から実際に強制される。超えると UTC 0 時まで
**全ユーザーが記録できなくなる**ので、予算は設計の制約として扱う。

**デバイス登録の書き込みは無視できる。** 1 回で最大 4 行 (トークンの発行 1 + `keys` 1 + `graphs` 0〜1 + トークンの削除 1) で、
サインインは初回とデバイス追加のときだけ。

読みは日次 500 万行あるので、UPSERT の前に SELECT する余裕がある。
no-op な UPDATE が rows written にカウントされるかは公式に記述がないので、それに依存しない。

### データの保持期間

| データ | 保持 |
|---|---|
| 分単位のビットマップ (`daybits`) | **90 日。** Cron で削除する。集計済みなので情報は失われない |
| 日次の集計値 (`daily`) | **削除しない。** 利用者が自分で削除するまで持つ |
| 公開鍵 (`keys`) | 失効させるか、利用者のデータ全体を削除するまで |
| 登録トークンのハッシュ (`enroll_tokens`) | 使うまで。使わなければ 5 分で無効になり、Cron が消す |

**日次の集計値を無期限に持つ。** 数年後に振り返れることを要件として選んだ (ADR-0013 の改訂)。

容量の見積もり。活動しなかった日は行が作られないので、週 5 日稼働で 3 プロジェクトを使う人の場合。

| | 値 |
|---|---|
| 1 行のサイズ | 約 75 バイト (uid 27 + ph 16 + day 10 + 整数 4 個 + インデックス)。**段階 9 と 10 で整数が増える** (下) |
| 1 人 1 年の行数 | 約 1,040 |
| 1 人 1 年の容量 | 約 78KB |
| **Free 枠 500MB で持てる量** | **約 6,400 人年** |

1,000 人が 6 年使える規模。100 人なら 64 年なので、実質的に気にする必要がない。

この見積もりは整数 4 個の時のもので、段階 9 で 3 個 (`wc` / `wo` / `links`)、段階 10 で 8 個 (時間帯の区間。ADR-0024) 増える。
SQLite の整数は値に応じて 1〜8 バイトで、分の値 (0〜1440) は 2 バイトに収まるので、1 行は 100 バイト前後になると見る (測っていない)。
桁が変わるほどではない。

読み取りも問題ない。10 年分を 1 枚の草に描いても 14,600 行で、日次 500 万行の枠に余裕がある。

**枠に近づいたら有料プランに移る** (月 5 ドルで 10GB)。年次アーカイブによる圧縮も技術的には
できるが、スキーマが複雑になるので採らない。容量を可観測性で監視する。

### 可観測性

公開提供するので、壊れたときに気づく経路が必要。**Worker 側だけ、追加コストのない範囲で作る** (ADR-0013)。

Workers Logs と Analytics Engine に出すもの。

| 指標 | 見る理由 |
|---|---|
| **D1 のデータベースサイズ** | **500MB に近づいたら有料プランへ移る判断材料** |
| 日次の rows written の概算 | 枠が尽きる前に気づく |
| 署名検証の失敗率 | 鍵の不整合や攻撃の兆候 |
| ID トークン検証の失敗率と理由 | Google 側の変更 |
| **COOP フォールバックの発生率** | **Google が COOP を enforced にしたら跳ね上がる。最重要** |
| D1 のエラー率 | 枠の超過や障害 |
| 新規登録数 | 乱用の兆候 |

**uid をログに出さない。** 集計値だけにする。個別の問題を再現できなくなるが、
「サーバに個人を追跡できる記録を残さない」方を優先する。

Cron で日次の要約をログに出す。UserScript 側のエラーは送らない。
送信先が増えてリクエスト枠を使い、何を送るかをポリシーに書く必要が出るため。

**Google の OAuth クライアントは 6 か月使われないと自動で消える** (トークンの要求も設定の変更も無い状態。
research §6、Issue #141)。削除の 30 日前に Google Cloud の連絡先へメールが来る。サインインは端末を足すときだけなので、
利用が少ない時期は本当に 6 か月空きうる。メールが来たら `/auth/start` を 1 回通せば止まる。

### 配布

**専用の公開プロジェクトを 1 つ作り、リリースのたびにバンドルを手動で貼る** (ADR-0013)。

自動化は `page-edit-for-ai` API と Personal Access Token でできるが、**PAT はスコープがなく、
そのアカウントが見られる範囲すべてにアクセスできる**。CI の Secrets に置くのは釣り合わない。
リリース頻度が上がったら再検討する。

破壊的変更のときは配布ページを分ける。同一パスの中身を差し替えるのは、他人のブラウザで動く
コードを勝手に入れ替えることになる。

**貼り忘れは CI で見張る** (2026-09-14、Issue #47、`.github/workflows/distribution.yml`)。1 日 1 回、main から作ったバンドルと
配布ページの `script.js` を SHA-256 で比べ、違えば `distribution: stale` の Issue を立てる (開いていれば本文を更新し、一致したら閉じる)。

- **同じ commit から作ったバンドルはバイト単位で一致する**ので、中身のハッシュをそのまま比べる。Worker だけ変わった commit では古いとしない
- **キャッシュを避けるクエリを付けて取る。** `/api/code/...` はエッジに 2 時間キャッシュされ (research §2)、付けないと貼った直後に誤検知する。
  利用者に届くまでの遅れは見張らない
- 見張るのは `dev` だけ (追従させる相手は main)。リリース版を作るときに、比べる相手 (タグなど) と一緒に増やし方を決める
- **required の検査にしない。** 外部の都合で赤くなりうるので `ci.yml` と `npm run check` から切り離す

### 連絡先

**GitHub の Issue を連絡先にする。** プライバシーポリシーにもそう書く。
メールアドレスを公開せずに済み、やりとりが記録に残る。

---

## 12. 実装順序

段階ごとに動作確認してから次へ進む。1 PR = 1 関心事。
**各段階の成果物・テスト項目・完了条件と、開発環境の整備は [roadmap.md](roadmap.md) にある。**

**段階 5 は段階 4 より先に入れた** (2026-09-14、Issue #49)。段階 4 は Google Cloud の OAuth クライアント (持ち主の手作業) が
無いと端から端まで通せない。段階 5 は外部の準備が要らず、完了条件が「1 日使って実感と合う」なので早く入れるほど観察の時間が取れる。
センサーは uid も鍵も使わないので、段階 4 と独立に作れる。

1. **基盤と SVG 生成・配色** — ダミーデータで `/v1/g/demo.svg`。Cosense に貼って実表示を確認する。
   **この段階で CI に型チェックとテストを足す**
2. **実機検証** — §14 の未検証事項を潰す。設計の前提なので実装の前に確認する
3. **D1 と `GET /v1/p.gif`** — curl で冪等性を確認する。`graphs` の解決、`*` 行の OR、
   署名検証、`ph` のバリデーションを含める。二重計上が起きないことをテストで固定する
4. **Google サインインとデバイス登録** — ポップアップ、ID トークン検証、`enroll`、フォールバック
5. **UserScript のセンサーとビットマップ** — 送信せず console で挙動確認。
   特に `by === "edit"` で他人の編集を弾けているか。bit をプロジェクト行と `*` 行の両方に立てる
6. **接続** — 実データで 1 週間動かす。**2 台以上のデバイスと 2 つ以上のプロジェクトで確認する**
7. **パラメータ確定** — §13 を実測値で決める
8. **草のダイアログと設定 UI** (当初は「DOM 注入とツールチップ」。ツールチップは ADR-0019 で無くなった)

## 13. テスト

- `shared/bits.ts` base64url 往復、OR の冪等性、popcount
- `worker/graph/scale.ts` 四分位。**比較が `<=` であること**と、離散値が少ないと四分位が同値に潰れるケース
- `worker/graph/scheme-cvd.test.ts` 配色を P・D・T 型の色覚シミュレーションにかけ、見分けやすさの下限を固定する (ADR-0023)
- `shared/ids.ts` uid が 27 文字であること。`ph` が uid でソルトされていること。
  プロジェクト別 publicId から uid も
  全体用 publicId も導けないこと
- `shared/sign.ts` 正規化が両端で一致すること。重複キーを検出すること
- `worker/idtoken.ts` ID トークンの検証。**`iss` の 2 形式を許容すること**、`alg` が RS256 以外なら
  拒否すること (JWKS を取りに行かないこと)、`nonce` の不一致を拒否すること、未知の `kid` で JWKS を 1 回だけ再取得すること。
  外部への fetch はモックせず、**取得関数を注入して** Google と同じ形の JWKS を返す
- `worker/uid.ts` 既知の答えと一致すること (HMAC の鍵の取り決めを固定する)
- `worker/auth.ts` **cookie と state が通るまで Google に fetch しないこと**、state の不一致・cookie の改ざんと期限、
  別のホストの callback が 404 であること、成功でも失敗でも cookie を消すこと、`error_description` を反射しないこと、
  CSP のハッシュが HTML の中身と一致し COOP が無いこと、postMessage の送り先が `https://scrapbox.io` であること、
  **表示したコードで `/v1/enroll.gif` が通ること**、ログに値が出ないこと
- `worker/auth-cookie.ts` `__Host-` の属性、改ざん・別の secret・**`WORKER_SECRET` をそのまま鍵にした MAC では通らないこと**
- `worker/ingest.ts` 同じビーコンを 2 回送って値が変わらない。未来と 30 日超の過去を拒否する。
  `r & ~w` の排他。`daybits` がない日に古いビーコンが来ても `daily.w` が減らない。
  **2 つのプロジェクトで同じ分に活動したとき `*` 行の `w` が 2 にならず 1 になること**。
  **署名が 64 バイトでなければ拒否すること** (DER を渡されたときに静かに通らないこと)。
  リプレイ窓の外を拒否すること。不正な `ph` を拒否すること
- `worker/svg.ts` スナップショットで構造の回帰を見る。`viewBox` と凡例があること
- `worker/svg-golden.test.ts` **本文の SHA-256 を既知の答えで固定する** (2026-09-15、Issue #73)。デモのライト・ダーク・`mode=write`・`weeks=10`・`weeks=1`、
  母集団が空、今日が日曜・土曜。
  **描画を意図して変える PR は答えを更新し、見た目の証跡を付ける**

バグ修正は失敗する再現テストを先に書く。新しいテストは検証対象の振る舞いを一時的に壊して
赤くなるのを見てから仕上げる。

テスト環境は `@cloudflare/vitest-plugin` (旧 `vitest-pool-workers`)。
マイグレーションは `readD1Migrations` と `applyD1Migrations` で適用する。

## 14. 実装前に確認すること

どれも設計の前提になる。段階 2 で潰す。

- ECDSA P-256 のラウンドトリップ (ブラウザで sign、Workers で verify)。**2026-09-14 に Chrome で成立** (research §5)
- `importKey("jwk", ...)` に Google の JWK をそのまま渡して通るか。**`{kty, n, e}` だけを渡す形にし、Google と同じ形の JWK
  (`alg`・`use` つき) から読み込めることを workerd のテストで固定した** (2026-09-14、Issue #61)。本物の JWKS では callback の実装で確かめる
- **ポップアップから `window.opener.postMessage` が scrapbox.io のプロジェクトページに届くか**
- ポリシー URL 未設定のまま non-sensitive スコープのアプリを publish できるか
- Rate Limiting binding が Free プランで使えるか
- no-op な UPDATE が rows written にカウントされるか
- `extractable: false` の `CryptoKey` を IndexedDB から読み戻せるか (Firefox に報告あり)。**Chrome では読み戻せた** (2026-09-14)

## 15. 未決パラメータ

すべて 1 週間分の実データを見てから決める。それまでは仮値で実装してよい。

| パラメータ | 仮値 | 決め方 |
|---|---|---|
| `tanh` の除数 | 1.2 | バランスの効き。小さいと端の色に振り切れ、大きいと中央の色に集まる |
| 離席判定 | 3 分 | 無操作でこれを超えたら数えない |
| デッドゾーン | 3 分 | 1 日の合計がこれ未満なら Level 0 扱い |
| 外れ値除去 | Q3 + 1.5 × IQR | 強すぎると繁忙期が潰れる |
| 当日の送信回数の上限 | 4 回 | 共有 SVG の鮮度と書き込み予算のトレードオフ |
| リプレイ窓 | ±5 分 | 破壊的操作は 60 秒 |

1 週間ログを取れば、`center` の実測値・読み書き比・分布の形が同時に分かる。

## 16. 既知のトレードオフ

いずれも意図的な選択。

- **過去のマスの色が後から変わる。** 四分位は全期間の分布で決まるので、今日大量に書くと
  去年のマスが薄くなる。GitHub も同じ挙動
- **明度は活動量と偏りの両方をわずかに表す** (ADR-0023)。配色は書き寄りほど明度を少し上げている
  (Level の段差の 4 割程度)。色相が区別できない人にも順序が伝わる手がかりと引き換え
- **色覚の違いがある人には、5 列のうち間の列が隣と同じ色に見える。** 明度を活動量に使う以上、
  色相だけで 5 段階は分けられない。保証するのは両端と中間の 3 段階 (ADR-0023)
- **2 次元にしたぶん一覧性は落ちる。** `?mode=write` の単色モードを必ず用意する
- **導入日より前の活動は一切存在しない。** 読みは原理的に取得不能で、書きも遡らないと決めた。
  導入直後の草は空になる
- **20 秒間隔のポーリングは分境界で過大に数えうる。** 実作業 20 秒でも 2 分計上されることがある
- **活動の少ないプロジェクトの草はほぼ真っ白になる。** スケールを合算から取る帰結で、
  並べて比較できることとの引き換え
- **プロジェクト名を変更すると `ph` が変わり、別プロジェクト扱いになる。** 稀なので許容する
- **プロジェクト別の合計が合算を下回ることがある。** Cron でビットマップを消した後に
  プロジェクト別の行だけ再送されないケース。表示側でこれを矛盾として扱わない
- **草は最大 1 日遅れる。** 送信頻度を落とした帰結 (ADR-0010)。**自分の草も同じ** (ADR-0019 以降)。
  急ぐときは「今すぐ送る」
- **破壊的操作が GET になる。** CSP が `connect-src` を塞いでいるため。署名と短いリプレイ窓で補う
