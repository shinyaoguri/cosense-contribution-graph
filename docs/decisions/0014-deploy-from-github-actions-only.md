# ADR-0014 デプロイは GitHub Actions からだけ行う

日付 2026-09-12 / 状態 採用

## 問題

Cloudflare のアカウントを複数持っていて、**`wrangler login` で認証しているのとは別のアカウント**に
デプロイしたい。`wrangler login` のグローバル認証は 1 つしか持てない。

さらにローカルから手で `wrangler deploy` を打つと、どのアカウントに向いているか分からないまま
実行する事故が起きる。非対話で複数アカウントに属している場合に
**リストの先頭を黙って選ぶ挙動**が workers-sdk の issue で議論されており、未解決のまま残っている。

## 決定 1 — デプロイは GitHub Actions からだけ

`main` への push で動かす。順序は **D1 マイグレーション → コードデプロイ**。

マイグレーションを先にするのは、逆にすると新しいコードがまだ無いテーブルを引く時間帯ができるため。
**識別子はバインディング名ではなくデータベース名で指定する。** バインディング名は変わりうるが
データベース名は変わらないので、誤ったデータベースに当てる事故を避けられる (公式の注記)。

ローカルに `npm run deploy` は置かない。`npm run build` は `wrangler deploy --dry-run` なので
アカウント認証なしでバンドルの検証ができる。

## 決定 2 — ローカルは認証プロファイルをディレクトリに束縛する

wrangler 4.131.1 に認証プロファイルがある (2026-07-02 のリリースで追加)。

```sh
npx wrangler auth create <名前>
npx wrangler auth activate <名前> /Users/so/Repos/cosense-contribution-graph
npx wrangler auth list
```

ディレクトリに束縛すると、そのディレクトリ以下では自動的にそのプロファイルになる。

**ただし `wrangler auth create` / `activate` / `list` はすべて `[experimental]` と表示される。**
破壊的変更がありうるので、代替手段も用意しておく。

代替は**ワンショットの環境変数**。そのアカウント用の API トークンを用意し、必要なコマンドだけに渡す。

```sh
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler d1 create cosense-grass
```

`wrangler login` の認証情報を壊さず、トークンをファイルに残さない。
1Password から読んで渡せば平文で置く必要もない。

## 決定 3 — ローカルに `CLOUDFLARE_API_TOKEN` を置かない

公式が優先順位を明記している。**`CLOUDFLARE_API_TOKEN` はすべての認証プロファイルを上書きする。**
シェルの rc ファイルや `.env` に置くと、意図しないアカウントに向いたまま気づかない。

`.env` に置くのは特に危うい。**wrangler CLI はこのファイルを読むが、同時にローカル開発時の
Worker の `env` にもロードされる** (`.dev.vars` も `secrets.required` も無い場合)。
ローカルの秘密値は `.dev.vars` に置き、`.env` は使わない。

## 決定 4 — `wrangler.jsonc` に `account_id` を書く

誤アカウント防止の二重化。プロファイルの束縛が外れていても、設定ファイルが対象を固定する。
アカウント ID は秘密ではないのでコミットしてよい。

**2026-09-12 の補足 — 値が揃うまではキーごと省く。** `--dry-run` は `requireAuth` を
通らないのでアカウントを一切参照せず、`wrangler types` も API を呼ばない。
**値が無いうちはキーごと省いても何も失われない** (不正な値を置くと逆に `--dry-run` が壊れる)。
段階 0 で認証プロファイルを束縛した時点で `wrangler whoami` から ID が取れたので、
同じ段階で入れた。

## 決定 5 — CI 用トークンは account-owned token にして D1 Edit を足す

**「Edit Cloudflare Workers」テンプレートに D1 は含まれない。** 公式の一覧では
Workers Routes Write / Workers Scripts Write / Workers KV Storage Write / Workers Tail Read /
Workers R2 Storage Write / Account Settings Read / User Details Read / User Memberships Read の 8 つで、
D1 がない。

**`wrangler d1 migrations apply --remote` には Account > D1 > Edit が必要。**
2025-05-02 の D1 リリースノートで、書き込みに `D1:Edit` が要ると明記された
(それ以前は `D1:Read` だけで書けてしまっていた)。

絞る方針。

- ベースは「Edit Cloudflare Workers」、**追加で Account > D1 > Edit**
- 使わない権限は落とす。KV も R2 も Tail も使っていない
- **Account Resources を対象アカウント 1 つに限定する**
- TTL (`expires_on`) を設定する。既定では期限切れしない
- **account-owned token** にする。ユーザーに紐づく token ではなく独立した権限セットなので、
  作成者のアカウント状態に左右されない

## 決定 6 — OIDC は使えないので長命トークンを Environment secrets に置く

**Cloudflare は GitHub Actions の OIDC によるトークンレス認証をサポートしていない** (2026-09-12 時点)。
`wrangler-action` の要望 (#402) と workers-sdk の議論 (#11434) はどちらも open のままで、
Cloudflare 側からの回答もロードマップの提示もない。

長命の API トークンを置くしかない。緩和策は 2 つ重ねる。決定 5 のトークン自体の絞り込みと、
**置き場を Environment secrets にすること。**

Repository secrets はリポジトリの全ワークフロー・全ジョブから読める。
Environment secrets は `environment:` を宣言したジョブだけが読み、さらに Environment 側で
**deployment branch を `main` に限定できる。** この限定は**ワークフローの `if` と独立に
GitHub 側で強制される**ので、ファイルの書き換えから独立した層になる。
段階 8 で週次の外部リンク検査ワークフローを足す予定があり、Repository secrets だと
それも射程に入ってしまう。

**required reviewers は付けない。** 毎回のデプロイが承認待ちで止まり、
「Actions から自動でデプロイする」という決定 1 と衝突する。

`CLOUDFLARE_ACCOUNT_ID` は置かない。`account_id` を設定ファイルに書いた時点で不要
(wrangler は両者を代替として扱い、設定がある方でアカウント一覧の API 呼び出しを省く)。

`cloudflare/wrangler-action` は使わず `npx wrangler deploy` を直接呼ぶ。
**マイグレーションとデプロイの順序を明示したいので、そのほうが素直。**
外部 action に依存しないという方針とも揃う。

## 決定 7 — secrets は CI が毎回 `--secrets-file` で渡す (2026-09-13 追加)

`secrets.required` を宣言しているので、**Worker がまだ存在しない状態の `wrangler deploy` は、
宣言した secret が揃わないと必ず例外になる** (wrangler の secrets-validation をソースで確認)。
`wrangler secret put` は Worker が存在しないと使えないので、初回は `--secrets-file` しか通らない。
決定 1 がローカルからのデプロイを禁じているので、打てる場所は CI しかない。

**初回だけの特別な段は作らず、毎回渡す。** 2 回目以降の secret は `inherit` バインディングになり、
渡しても無害。`workflow_dispatch` の一回限りの段を別に持つより経路が 1 本で済む。

**ファイルは JSON で書く。** wrangler はファイルをまず JSON として読み、失敗したら dotenv として
読む (`parseBulkInputToObject`)。dotenv は引用符を剥がし、値の中の ` #` 以降を注釈として捨てる。
**`WORKER_SECRET` は一度決めたら変えられない**ので、化けた値が初回デプロイで入ると取り返しがつかない。

**シェルに値を展開させない。** `run:` に `${{ secrets.* }}` を書くとスクリプトの文字列に
埋め込まれてから実行される。`env:` で渡し、Node が `process.env` から読んで `JSON.stringify` で
書く。権限は 600、デプロイの後は `if: always()` で消す。

値は `openssl rand -hex 32` で作る。16 進数はどの形式で扱っても化ける文字を含まない。

## 決定 8 — バインディングと `secrets.required` は使っているコードに合わせて足す (2026-09-13 追加)

段階 0 では段階 3 以降の足場として D1 (プレースホルダの ID)・レート制限・Google の secret 2 つを
先に宣言していた。**`--dry-run` はこれで通るが、本番デプロイは通らない見込みだった。**

- **D1** — 存在しないデータベースを指す。本番デプロイはバインディングを実アカウントと照合する
- **レート制限** — Free プランで使えるかが未検証 (段階 2 の項目)。使えなければデプロイがそれで落ちる
- **Google の secret** — 段階 4 まで使わないのに、揃えるには仮の OAuth の値を本番に置くしかない

**疎通確認がこれらで落ちると、落ちた理由が疎通と関係なくなる。** 使う段階まで外し、
そのコードと一緒に足す。どちらもクライアント側の検査は無く Cloudflare の API 側の判定なので、
wrangler のソースからは確かめられなかった。

`WORKER_SECRET` だけは残す。初回デプロイから存在すべきで一度決めたら変えられず、1 つでも宣言が
残っていれば `wrangler types` が `.dev.vars` を無視する性質 (ローカルと CI で型がずれない) が保たれる。

**2026-09-14 の改訂 — Google のうち secret だけを `secrets.required` に足した** (Issue #61)。「Google の secret 2 つ」と書いていたが、
**クライアント ID は秘密ではないので `vars` に置く。** `GOOGLE_CLIENT_SECRET` は `/auth/callback` と一緒に `secrets.required` に足し、
`ci.yml` の guard と secrets ファイルにも足した (名前の配列で持ち、`secrets.required` と同じ並びにする)。
`vars` はデプロイのたびに置き換わり、`--secrets-file` を渡すと secret は残る (research §5)。

## 決定 9 — D1 は CI の deploy ジョブが無ければ作る (2026-09-14 追加)

roadmap は「`wrangler d1 create cosense-grass` をローカルから 1 回だけ打つ」としていたが、決定 1 (リモートの操作は
CI だけ) と食い違っていた。**deploy ジョブのマイグレーションより前に「無ければ作る」段を置き、毎回走らせる** (Issue #36)。
初回だけの段を別に持たないのは決定 7 と同じ理由。

- **今のままでは初回で必ず落ちる。** マイグレーション (`d1 migrations apply --remote`) が先に走り、データベースが無いと失敗する。
  `wrangler deploy` は `database_id` が無ければデータベースを自動で作るが、その段まで進まない (research §5)
- **有無は `wrangler d1 list --json` で見る。** `d1 info` は分析用の GraphQL も叩くので、トークンの権限次第で
  データベースがあっても失敗し、作り直そうとして落ちうる。一覧が取れない・読めないときは作らずに落とす
- **`--location apac` を付ける。** 付けないと作成を要求した場所 (GitHub のランナー) の近くに置かれる。
  `wrangler deploy` の自動作成は場所を指定できないので、先に作る
- **作った後に `database_id` を `wrangler.jsonc` に固定する。** ID が無い間は wrangler が名前で探す。固定すれば、
  データベースが消えたときにマイグレーションの段で落ちて気付ける (名前で探す間は、黙って空のデータベースを作り直しうる)
- ID は Actions のログに出る。アカウント ID と同じく秘密ではない
- 決定 2 の「ワンショットの環境変数で `d1 create`」の例は、D1 については使わない

## 決定 10 — 独自ドメインはダッシュボードで付け、`wrangler.jsonc` に `routes` を書かない (2026-09-14 追加)

**Worker を `grass.soui.dev` に載せた** (Issue #61)。持ち主のドメイン `soui.dev` は同じ Cloudflare アカウントのゾーンで、
サブドメインをダッシュボードの Custom Domain で付けた。

- **独自ドメインにした理由。** Worker の URL は配布する UserScript、利用者が Cosense に貼る共有 SVG、Google のリダイレクト URI に
  書き込まれ、公開後は変えられない。利用者がいない今なら変えるコストがほぼ無い。`workers.dev` にはゾーンの WAF が効かず
  レート制限を置けない (design §10)。Cloudflare から移ってもドメインは持ち出せる
- **`routes` を書かない理由。** 宣言すると CI 用トークンにゾーンの権限 (Workers Routes など) を足す必要があり、決定 5 の
  「アカウント 1 つに限定した最小の権限」から広がる。`routes` が空なら `wrangler deploy` はダッシュボードのカスタムドメインに
  触らない (research §5 で wrangler のソースを確認)。ドメインは一度付ければ変えないので、コードで管理する利点が小さい
- **`workers_dev: true` は残す。** デモの草など、すでに貼られた `cosense-grass.soui.workers.dev` の URL を壊さない。
  UserScript と docs の新しい記述は `grass.soui.dev` を使う
- **`soui.dev` の更新を切らさない。** 失効すると UserScript も貼られた草も止まる
- **WAF のレート制限ルールはまだ置いていない。** 公開提供の前に置く (design §10)

## 帰結

- **ローカルでアカウント認証が必要なのは初回セットアップだけになる。**
  `wrangler dev` と `wrangler types` と `--dry-run` と `--local` のマイグレーションは
  認証なしで動く見込み。ただしこれは公式に明言がないので段階 0 で実測する
- トークンが漏れたら、そのアカウントの Worker を書き換えられる。
  TTL と最小権限とアカウント限定で被害の範囲と期間を絞る
- デプロイの履歴が Actions に残る。誰が何をいつデプロイしたかが後から読める
- **初回デプロイは `wrangler deploy --secrets-file` で secrets と一緒に投入する。**
  `secrets.required` を宣言していると未設定の secret があるとデプロイが失敗するため
