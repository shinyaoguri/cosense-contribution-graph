# 実装計画

設計は `design.md`、判断の根拠は `decisions.md`、前提となる実測事実は `research.md` にある。
この文書は**それを実行する順番と、各段階の完了条件**を書く。

段階ごとに動かして確認してから次へ進む。1 PR = 1 関心事。

---

## 段階 0 — 開発環境を整える

コードは書かない。**main ブランチには今 `LICENSE` と `README.md` と `docs/` しかない。**
`.gitignore` も `CLAUDE.md` もないので、まずそこを埋める。

### 採用する道具

このマシンの既存リポジトリの慣習に合わせた。揺れている項目は多数派を採っている。

| | 採用 | 理由 |
|---|---|---|
| パッケージマネージャ | **npm** | 既存 23 リポすべて `package-lock.json`。揺れなし |
| Node | `engines.node: ">=24"` + CI は `node-version: 24` | 多数派。`.nvmrc` と `.node-version` は併置しない |
| lint / format | **biome v2** 一本 | 新しい 7 リポが biome。eslint + prettier の 2 本立てにしない |
| テスト | **vitest 4.1.x** | 揺れなし。`@cloudflare/vitest-plugin` の peer が `^4.1.0` なので**5 系に上げない** |
| 未使用依存の検出 | **knip** | 新しい 3 リポが採用 |
| Worker 設定 | **`wrangler.jsonc`** | 公式が新規プロジェクトに推奨。既存も 5 対 1 で jsonc |
| UserScript のバンドル | **esbuild** (IIFE) | Cosense は `<script>` で読むので ESM は使えない |
| CI | **単一ジョブで直列** | Actions の課金はジョブ単位の分切り上げ。秒で終わる仕事に独立ジョブを与えない |
| デプロイ | **GitHub Actions からだけ** | 複数アカウントを持っているので、ローカルから打つと誤アカウントへの事故が起きる (ADR-0014) |

**`.editorconfig` は置かない。** 個人標準で明示的に不採用 (フォーマットは biome に任せる)。

### 作るファイル

```
.gitignore                      Workers + D1 + .claude/worktrees/
CLAUDE.md                       リポ固有の文脈だけ。100 行以内。検証コマンドを載せる
package.json                    scripts と devDependencies
tsconfig.json                   共通の compilerOptions のみ。files: []
tsconfig.worker.json            src/worker + src/shared。lib に DOM を入れない
tsconfig.userscript.json        src/userscript + src/shared。lib に DOM を入れる
test/tsconfig.json              @cloudflare/vitest-plugin/types
biome.json                      lineWidth 100 / space 2
knip.json
wrangler.jsonc                  D1 / Cron / ratelimits / secrets.required
vitest.config.ts                projects を列挙する薄い root
vitest.worker.config.ts         cloudflareTest + readD1Migrations
vitest.userscript.config.ts     environment: jsdom
test/apply-migrations.ts        applyD1Migrations
scripts/build-userscript.mjs    esbuild の Build API
scripts/check-pr-title.sh       Conventional Commits の 9 type を検査
migrations/0001_init.sql        空で置くか、段階 3 で作る
.github/workflows/ci.yml        既存を更新 (下記)
.github/dependabot.yml          npm + github-actions / monthly / grouped / limit 1
.github/pull_request_template.md  目的 / 変更点 / 確認方法
.claude/settings.json           permissions。deploy 系は deny に置く
```

### `package.json` の scripts

**`check` が最重要。** ローカルの push 前ゲートと CI が同一コマンドになり、乖離が構造的に防げる。

```json
{
  "lint": "biome check .",
  "lint:fix": "biome check --write .",
  "typecheck": "wrangler types --check && tsc -p tsconfig.worker.json && tsc -p tsconfig.userscript.json && tsc -p test/tsconfig.json",
  "test": "vitest run",
  "test:watch": "vitest",
  "knip": "knip",
  "dev": "wrangler dev --test-scheduled",
  "typegen": "wrangler types",
  "build:userscript": "node scripts/build-userscript.mjs",
  "build": "wrangler deploy --dry-run && npm run build:userscript",
  "db:migrate:local": "wrangler d1 migrations apply cosense-grass --local",
  "check": "npm run lint && npm run typecheck && npm run knip && npm test && npm run build"
}
```

`build` に `--dry-run` を使うのは、**Cloudflare アカウントなしでバンドルの検証ができる**ため。

**`deploy` と `db:migrate:remote` はローカルに置かない。** どちらも GitHub Actions からだけ実行する
(ADR-0014)。リモートを触るコマンドがローカルの `npm run` に並んでいると、手が滑ったときに止められない。

### ローカルの認証

`wrangler login` のグローバル認証は 1 つしか持てない。**別のアカウントを使うので、
認証プロファイルをこのディレクトリに束縛する。**

```sh
npx wrangler auth create <名前>
npx wrangler auth activate <名前> /Users/so/Repos/cosense-contribution-graph
npx wrangler auth list
npx wrangler whoami
```

**`wrangler auth` のサブコマンドは 4.131.1 時点ですべて `[experimental]`。**
壊れたら、そのアカウント用の API トークンを必要なコマンドだけにワンショットで渡す形に切り替える。

```sh
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler d1 create cosense-grass
```

**`CLOUDFLARE_API_TOKEN` をシェルの rc ファイルや `.env` に置かない。**
この変数はすべての認証プロファイルを上書きするので、意図しないアカウントに向いたまま気づかない。
`.env` は特に危うく、wrangler CLI が読むだけでなくローカル開発時の Worker の `env` にも入る。
ローカルの秘密値は `.dev.vars` に置く。

`wrangler.jsonc` に `account_id` も書いて二重化する。アカウント ID は秘密ではない。

### tsconfig を 3 つに分ける理由

`worker-configuration.d.ts` は workerd の runtime 型 (`Response` / `Request` / `crypto`) を
グローバルに宣言する。これを DOM の lib と同時に読むと同名グローバルが衝突し、
Worker 側から `document` が見えてしまう。

**lib を分けることで「`src/shared/` には両方の lib で通るコードしか置けない」を機械的に強制できる。**

`paths` は使わず相対 import にする。バンドラが 2 つある (UserScript は自前の esbuild、
Worker は wrangler 内蔵の esbuild) ので、解決規則を揃える手間に見合わない。

### `wrangler.jsonc` の要点

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "cosense-grass",
  "main": "src/worker/index.ts",
  "account_id": "<ACCOUNT_ID>",
  "compatibility_date": "2026-09-12",
  "observability": { "enabled": true },
  "d1_databases": [
    { "binding": "DB", "database_name": "cosense-grass",
      "database_id": "<UUID>", "migrations_dir": "migrations" }
  ],
  "ratelimits": [
    { "name": "INGEST_LIMITER", "namespace_id": "1001", "simple": { "limit": 60, "period": 60 } },
    { "name": "ENROLL_LIMITER", "namespace_id": "1002", "simple": { "limit": 5,  "period": 60 } }
  ],
  "triggers": { "crons": ["17 3 * * *"] },
  "secrets": { "required": ["WORKER_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] }
}
```

細かいが重要な点。

- **`compatibility_flags` を書かない。** `compatibility_date` が `2026-08-04` 以降なら
  `nodejs_compat` と `nodejs_compat_v2` が既定で有効。公式が「新しい設定からは省け」と明記している
- **`secrets.required` を使う。** デプロイ前に未設定の secret を列挙してエラーで止まり、
  `wrangler types` の型生成もここを見る。`.dev.vars` がない CI でも型が安定する
- **`ratelimits` の `period` は 10 か 60 しか取れない。** `namespace_id` は正整数を文字列で書く
- **`triggers.crons` は UTC。** デプロイのたびに内容で置き換わる。空配列にすると全削除される
- `database_id` は秘密ではないのでコミットしてよい

### vitest を 2 つの project に分ける

Worker のテストは workerd 内で走るので `document` がない。UserScript のテストは DOM が必要。
公式も「Workers Vitest integration で custom environment は非対応」と明記しているので、
同じ project には混ぜられない。

**`src/shared/**` を両方の project の `include` に入れる。** 同じコードが workerd と jsdom で
同じ答えを返すかを二重に検証できる。Worker が出す SVG と DOM 注入の草で配色が食い違わないこと
という設計の要求に、これが直接効く。

- `@cloudflare/vitest-plugin` からの import は**ルートから**。`/config` サブパスは存在しない
  (公式ドキュメントに古い記述が残っている)
- coverage は **istanbul**。V8 の native coverage は Workers plugin では使えない
- ストレージの分離はテストファイル単位。ファイルをまたいでデータは残らない

### CI の更新

既存の `ci.yml` は docs のリンクチェックだけで、`@v4` / `concurrency` なし / 小文字の `name` と
慣習からずれている。段階 0 で揃える。

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run check
      - name: Markdown の相対リンクを検査
        run: ./scripts/check-links.sh
      - name: PR タイトルの形式を検査
        if: github.event_name == 'pull_request'
        env:
          PR_TITLE: ${{ github.event.pull_request.title }}
        run: ./scripts/check-pr-title.sh
```

**PR タイトルの検査に外部 action を使わない。** 履歴の体裁を守るだけの検査に
サプライチェーンのリスクを負う理由がない。自前のスクリプトを置く。

**テストは Cloudflare の認証情報なしで green になること**を不変条件にする。
vitest の Workers project はローカルの workerd だけで走るので、API トークンは要らない。

`check-links.sh` が外部 URL を見ないのは意図的な判断なので変えない。docs が一次情報への出典を
大量に持つので、到達性を CI で見ると先方の都合で赤くなる。外部リンクの死活は後から週次の
別ワークフローに分ける。

### デプロイのジョブ

同じ `ci.yml` に足す。**`main` への push だけ、`ci` が通った後。**
必要になるのは段階 1 からだが、形は段階 0 で決めておく。

```yaml
  deploy:
    needs: ci
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: npm }
      - run: npm ci
      # secrets 未設定なら CI を落とさずスキップする
      - name: 認証情報の有無を確認
        id: guard
        run: |
          if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
            echo "::notice::CLOUDFLARE_API_TOKEN が未設定なのでデプロイをスキップします"
            echo "skip=true" >> "$GITHUB_OUTPUT"
          fi
      # スキーマはコードより先に上げる
      - name: D1 マイグレーションを適用
        if: steps.guard.outputs.skip != 'true'
        run: npx wrangler d1 migrations apply cosense-grass --remote
      - name: デプロイ
        if: steps.guard.outputs.skip != 'true'
        run: npx wrangler deploy
```

押さえる点。

- **マイグレーションをコードより先に適用する。** 逆にすると新しいコードがまだ無いテーブルを
  引く時間帯ができる
- **識別子はデータベース名で指定する。** バインディング名は変わりうるがデータベース名は変わらない
- **`--remote` を必ず明示する。** 省略時の既定はローカルで、公式ドキュメントの記述は実装と逆になっている
- **secrets 未設定なら `::notice::` を出してスキップし、CI を赤くしない。** 設定前でも PR が通る
- `cloudflare/wrangler-action` は使わず `npx wrangler deploy` を直接呼ぶ。
  マイグレーションとの順序を明示したいのと、外部 action に依存しない方針のため
- required status check は `ci` だけにする。条件付きでスキップされる `deploy` を required にすると
  auto-merge が永久に pending になる

**初回デプロイだけは `wrangler deploy --secrets-file` で secrets と一緒に投入する。**
`secrets.required` を宣言しているので、未設定の secret があるとデプロイが失敗する。

### 完了条件

- `npm run check` がローカルで green
- CI が PR で green になり、チェックが 1 件以上登録されている
  (今はチェックが 0 件で、green と区別が付かない)
- `npm run dev` で Worker が起動し、`/cdn-cgi/local/scheduled` で Cron を叩ける
- `npx wrangler whoami` が**使いたいアカウント**を指している
- **`wrangler logout` 相当の状態で `dev` / `types` / `--dry-run` / `--local` のマイグレーションが
  動くことを実測する。** 公式に認証不要と明言されていないので確認する

---

## 段階 1 — SVG 生成と配色

**最も不確実な部分を最小コストで潰す。** ダミーデータで `/v1/g/demo.svg` を返し、
Cosense のページに実際に貼って表示を確認する。D1 は使わない。

作るもの。

- `src/shared/scale.ts` 四分位スケール
- `src/shared/balance.ts` 色相バランス
- `src/shared/oklch.ts` OKLCH から sRGB。彩度を二分探索でガモットに詰める
- `src/shared/color.ts` セルの色
- `src/shared/graph.ts` 53 週グリッドのレイアウト
- `src/worker/svg.ts` SVG の生成。凡例込み
- `src/worker/index.ts` ルーティング

テストで固定すること。

- 四分位の比較が `<=` であること。`<` にすると離散値が少ないときに全マスが Level 4 になる
- 離散値が少なく四分位が同値に潰れるケース
- OKLCH の変換係数をリファレンス値と突き合わせる
- ガモット外 (高明度と青) で二分探索が効くこと
- SVG のスナップショット。`viewBox` と凡例があること

### 完了条件

**Cosense のページに `[https://<worker>/v1/g/demo.svg]` を貼って、草が表示されること。**
ライトとダークの両方。Gyazo に上げて PR に貼る。

ここで失敗したら設計の前提が崩れるので、先に進まない。

---

## 段階 2 — 実機検証

`design.md` §14 の未検証事項を潰す。**設計の前提なので実装の前に確認する。**
小さな検証用ページか、`wrangler dev` と DevTools で足りる。

| 確認すること | 失敗したときの影響 |
|---|---|
| ECDSA P-256 のラウンドトリップ (ブラウザで sign、Workers で verify) | 認証方式が成立しない |
| `importKey("jwk", ...)` に Google の JWK をそのまま渡して通るか | ID トークン検証の実装が変わる |
| **ポップアップから `postMessage` が scrapbox.io のプロジェクトページに届くか** | サインインが成立しない |
| `extractable: false` の `CryptoKey` を IndexedDB から読み戻せるか | Firefox で鍵が失われる |
| Rate Limiting binding が Free プランで使えるか | DoS 対策を WAF だけに寄せる |
| ポリシー URL 未設定のまま non-sensitive スコープのアプリを publish できるか | 公開の手順が変わる |
| no-op な UPDATE が rows written にカウントされるか | 書き込み予算の見積もりが変わる |

**結果は `research.md` に追記する。** 日付と出典を添えて、後から再検証できる形にする。

---

## 段階 3 — D1 と記録の受け口

`GET /v1/p.gif` を実装する。Google サインインはまだないので、署名の検証は通るが
uid は固定値を使ってよい。

作るもの。

- `migrations/0001_init.sql` スキーマ一式
- `src/shared/ids.ts` uid / ph / publicId の導出
- `src/shared/bits.ts` ビットマップの base64url 往復 / OR / popcount
- `src/shared/sign.ts` 署名対象の正規化
- `src/worker/ingest.ts`
- `src/worker/cron.ts` 90 日より古い `daybits` の削除

テストで固定すること。ここが一番多い。

- **同じビーコンを 2 回送って値が変わらない** (冪等性)
- **2 つのプロジェクトで同じ分に活動したとき、`*` 行の `w` が 2 にならず 1 になること** (二重計上の回帰)
- `r & ~w` の排他
- `daybits` がない日に古いビーコンが来ても `daily.w` が減らないこと
- 未来の日と 30 日より古い日を拒否すること
- **署名が 64 バイトでなければ拒否すること。** DER を渡されたとき静かに `false` が返るのを防ぐ
- リプレイ窓の外を拒否すること
- 不正な `ph` (12 桁の 16 進数でも `*` でもない) を拒否すること
- `ids.ts` の uid が 27 文字であること。`ph` が uid でソルトされていること。
  プロジェクト別 publicId から uid も全体用 publicId も導けないこと

### 完了条件

curl で同じビーコンを 2 回送り、`daily` の値が変わらないこと。
`wrangler d1 execute --local` で中身を確認する。

---

## 段階 4 — Google サインインとデバイス登録

- `src/worker/auth.ts` `/auth/start` と `/auth/callback`。ID トークンの検証
- `src/worker/enroll.ts` デバイスの登録と失効
- `src/userscript/keys.ts` 鍵ペアの生成と IndexedDB への保存
- `src/userscript/auth.ts` ポップアップと `postMessage` の受信

テストで固定すること。

- **`iss` の 2 形式を許容すること。** `https://accounts.google.com` と `accounts.google.com`。
  自前実装でよく落ちる
- `alg` が RS256 以外なら拒否すること。`none` や HS256 の混入を弾く
- `nonce` の不一致を拒否すること
- 未知の `kid` で JWKS を 1 回だけ再取得すること
- 登録トークンが 1 回使い捨てで 5 分で切れること

外部への fetch のモックは `@msw/cloudflare` を使う。`fetchMock` は現行ではない。

### 完了条件

2 台のデバイスから同じ Google アカウントでサインインし、**同じ uid になって同じ草に合流すること。**
COOP のフォールバック (コードを貼る経路) も実際に試す。

---

## 段階 5 — センサーとビットマップ

送信せず `console` で挙動を確認する。

- `src/userscript/sensor.ts` 20 秒ポーリングと `lines:changed`
- `src/userscript/store.ts` localStorage
- `src/userscript/beacon.ts` 画像 GET と署名
- `src/userscript/index.ts` 常駐とマウント

確認すること。

- **`by === "edit"` で他人の編集を弾けているか。** 共同プロジェクトで他の人に編集してもらう
- `document.hasFocus()` が効いているか。タブを裏に回して数えないこと
- bit がプロジェクト行と `*` 行の両方に立つこと
- 複数タブで localStorage を共有していること
- プロジェクトを移動したときに再注入されて動き続けること

### 完了条件

1 日使って、localStorage の日次集計が実感と合うこと。分バケットが過大でも過小でもないこと。

---

## 段階 6 — 接続

段階 3 から 5 を繋いで実データで 1 週間動かす。

- **2 台以上のデバイスで確認する。** 合算が OR でマージされること
- **2 つ以上のプロジェクトで確認する。** 二重計上が起きないこと
- 共有 SVG が Cosense のページで更新されること
- 書き込み量が予算に収まっていること

この週のデータが段階 7 の入力になる。

---

## 段階 7 — パラメータ確定

`design.md` §15 の仮値を実測で決める。1 週間のログから `center` の実測値、読み書きの比、
分布の形が同時に分かる。

決めるもの。`tanh` の除数、彩度の飽和点、離席判定、デッドゾーン、外れ値除去の強さ、送信の頻度。

**決めた値と、そう決めた根拠を `decisions.md` に ADR として残す。** 後から触るときに
「なぜこの数字か」が読めなくなるのを防ぐ。

---

## 段階 8 — DOM 注入と設定 UI

- `src/userscript/render.ts` 草とツールチップ。合算 1 枚 + プロジェクト別を並べる
- `src/userscript/settings.ts` サインイン、デバイス一覧と失効、共有 URL の一覧、
  read 計上の on/off、全データの削除
- `src/worker/admin.ts` 全削除

見た目は実物を見ながら詰める。証跡は Gyazo に上げて PR に貼る。
**動きが分からないと正誤を判定できないもの (ツールチップ、再マウント) はアニメーション WebP で。**

---

## 外部に用意するもの

段階ごとに必要になる順。**これは手を動かす作業で、コードでは代替できない。**

| いつ | 用意するもの | 備考 |
|---|---|---|
| 段階 0 | **認証プロファイルの束縛** | 使いたいアカウントで `wrangler auth create` / `activate`。`whoami` で確認 |
| 段階 0 | **CI 用の API トークン** | account-owned token。「Edit Cloudflare Workers」+ **Account > D1 > Edit**。KV / R2 / Tail は落とす。対象アカウント 1 つに限定。TTL を設定 |
| 段階 0 | **GitHub Secrets** | `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` |
| 段階 1 | Cloudflare アカウント | 無料枠。D1 はまだ不要 |
| 段階 1 | Cosense の確認用ページ | 自分のプロジェクトのどこかに 1 ページ |
| 段階 3 | D1 データベース | `wrangler d1 create cosense-grass`。**ローカルから 1 回だけ打つ** |
| 段階 4 | **独自ドメイン** | `workers.dev` では zone の WAF が効かず、レートリミットがかけられない |
| 段階 4 | **`WORKER_SECRET`** | uid の導出鍵。**失うと全利用者の識別子が再計算できなくなる。必ずバックアップ** |
| 段階 4 | Google Cloud の OAuth クライアント | `openid` スコープのみなら審査は不要 |
| 段階 4 | プライバシーポリシーの公開先 | Google の同意画面の要件。`privacy.md` を Worker から配信する |
| 段階 5 | **Cosense の配布用公開プロジェクト** | バンドルを貼る。リリースのたびに手動 |
| 公開時 | Bot Fight Mode を OFF | JS 実行を要求するチャレンジは画像ビーコンを静かに壊す |

---

## 保留している判断

- **`docs/decisions.md` を `docs/decisions/NNNN-<slug>.md` に分割するか。** 個人標準は
  ディレクトリ分割を要求しているが、現在は単一ファイルに ADR が 13 件ある。分割すると
  相互参照のリンクが増える。**段階 0 では触らず、ADR が 20 件を超えたら分割する**
- 週次の外部リンク死活検査ワークフロー。`check-links.sh` が意図的に外部 URL を見ないので、
  別途必要になる。ただし required にしない。**段階 8 の後**
- `.github/repo-settings.json` による GitHub 設定のコード化。設定変更が PR の diff に残る
  利点があるが、個人標準ではなく 1 リポジトリだけの実践。**採否は段階 0 で判断する**
- 配布の自動化。Personal Access Token はスコープがなくアカウント全体にアクセスできるので、
  CI の Secrets に置かない。**リリース頻度が上がったら再検討**
