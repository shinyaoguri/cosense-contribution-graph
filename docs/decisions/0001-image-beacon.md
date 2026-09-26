# ADR-0001 送信経路を画像 GET ビーコンにする

日付 2026-09-12 / 状態 採用

## 問題

指示書は UserScript から Worker へ `fetch` で POST し、離脱時は `navigator.sendBeacon` を使う前提だった。
しかし scrapbox.io の CSP は `connect-src` が allowlist で、自前ドメインが入っていない。
実機検証で `fetch` は `TypeError`、`sendBeacon` は戻り値 `true` ながら `connect-src` 違反が発火し、
どちらも送信されないことを確認した (`research.md` §1)。

指示書はこのケースを「本設計は成立しない。実装を中断し、報告すること」としていた。

## 決定

`img-src *` を使い、`new Image().src` でクエリにデータを載せた GET を Worker へ送る。
Google Analytics が長年使ってきた 1x1 GIF ビーコンと同じ仕組み。

Worker は 43 バイトの透過 GIF を 200 で返す。クライアントは `onload` で到達を判定できる
(`onload` は HTTP ステータスではなくデコード可能な画像が返ったかで決まる)。

`img.referrerPolicy = "no-referrer"` を `src` より前に設定する。既定でもクロスオリジンには
origin しか送られないが、origin も出さない。

## 2026-09-14 の改訂 — Service Worker の制御下では Referer にオリジンだけが届く

**上の「origin も出さない」は、Cosense の Service Worker がページを制御しているときは成り立たない**
(research §1、Issue #31)。Service Worker が画像リクエストを init つきの `fetch` で作り直すので、
ページで付けた `no-referrer` が捨てられ、**`Referer: https://scrapbox.io/` が届く。**

**これを受け入れる。** 届くのはオリジンだけで、プロジェクト名もページ名も含まない (非公開プロジェクトで実測)。
運営者にとって「Cosense のページから送られた」ことは Referer が無くても自明なので、失うものは無い。

- `no-referrer` の設定は残す。強制再読み込みで開いたページのように、制御外のときは効く
- Service Worker を避ける手段 (`media-src *` の `<video>` / `<audio>`) は、上の却下理由のとおり発火が不確実なので採らない
- **Worker は Referer でも `Sec-Fetch-Dest` でも判定しない。** 制御下では `Sec-Fetch-Dest` が `empty` になり、
  制御の有無で値が変わるため

## 2026-09-14 の改訂 — `/v1/p.gif` は幅 16 か 17 の透過 GIF を返す

上の「43 バイトの透過 GIF」を、**幅 16 + ビット (1 = D1 に書いた)** に改めた (design §6、Issue #36)。

- 同じ中身を 2 回送ると 2 回目は 16 になる。持ち主は本番の D1 を覗けない (ADR-0014) ので、冪等性を利用者の側で確かめる手段にする
- 16 から始めるのは、途中の何かが返した 1×1 の画像を「届いた」と取り違えないため。`/v1/probe.gif` と同じ考え方
- `onload` で到達を判定できる性質は変わらない。段階 5 の送信済みの判定は「幅が 16 か 17」で読む

## 帰結

- データは URL に載る。Cloudflare の上限 16KB が実効の制約。8KB を超えるなら分割送信する
- レスポンス本文を JavaScript から読めない。受信方向が必要になったら CORS 画像と canvas の
  ピクセル読み出しで実現できるが、当面は不要 (下の ADR-0003)
- `secret` が URL クエリに乗る。Cloudflare のアクセスログは Logpush を設定しない限り保存されないが、
  README に明記する。指示書 §12.1 が「secret 漏洩の実害は自分のグラフの汚染のみ」と受容しているので
  この設計と一貫する
- 画像は `keepalive` を持てないのでページ破棄時に中断される。これは ADR-0002 で無害化する

## 却下した代替案

**Cosense 自身をストレージにする。** `connect-src 'self'` なので同一オリジンへの書き込みは自由。
日次集計を自分のページの `code:kusa.json` に書き、Worker は `/api/code/...` から読む。
鍵が不要になり、複数デバイス同期とバックアップも同時に解決する。前例もある。

却下理由。Cosense 側の副作用が大きい。更新履歴が機械書き込みで埋まり、最終書き込みから 90 秒で
Slack 通知が飛ぶ。非公開プロジェクトでは Worker に Personal Access Token を預ける必要があり、
配布ツールとしては成立しない。また「できるだけ人の手を介してテキスト編集が行われるように作られている」
という Cosense の設計思想とも摩擦する。

ただし localStorage 消失対策とデバイス間同期が必要になったら、この案を後段で足せる。
書き込み手段は `@cosense/std` の WebSocket patch か、公式の `page-edit-for-ai` REST。

**Tampermonkey 前提。** `GM_xmlhttpRequest` は CSP を越えられるので指示書のまま実装できる。
却下理由は「1行書くだけで導入できる」というゴールを捨てることになる点。

**GCS への直接 PUT。** `storage.googleapis.com` が `connect-src` にある。
却下理由は署名付き URL の取得経路が自前サーバになり循環すること。公開書き込みバケットは
荒らしと課金のリスクがある。

**Sentry 経由。** `sentry.io` が `connect-src` にあり、公開 DSN は客体側に埋め込む設計なので
技術的にはデータを流せる。イベント枠の濫用であり却下。

**`media-src *` で `<video>` / `<audio>`。** request destination が `"audio"` / `"video"` になるので
Cosense の Service Worker の画像ルーティングをすり抜ける利点がある。
却下理由は Range 分割と `preload` 遅延があり画像より発火が不確実なこと。

## 2026-09-12 の改訂

2 点を差し替えた。

- **共有秘密を毎回送る方式をやめ、デバイスごとの鍵ペアによる署名にした** (ADR-0009)。
  公開提供すると決めたので、鍵が URL に乗ると運営者のログに全ユーザーの書き込み権が流れる
- **ここで却下した OAuth を採用した** (ADR-0011)。当時の却下理由は「サードパーティ Cookie が
  使えないのでどのみち localStorage に鍵が必要」「復旧は鍵を表示すれば済む」だった。
  前者は今も正しいので、OAuth はセッションではなく**身元の確定とデバイス登録にだけ使う**。
  後者は複数デバイスの自動統合という要件が加わり、かつ鍵を読まれる場所に置けないとなると
  成り立たなくなった

また、**画像リクエストの URL は Cosense の Service Worker が無条件に Cache Storage へ保存する**
(キーは URL、`Cache-Control` では止められない、48 時間で失効)。鍵を送らない設計にしたので
実害は消えたが、URL に秘密を載せない理由の 1 つとして記録しておく。
