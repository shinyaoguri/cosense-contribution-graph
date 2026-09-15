# 実装計画

設計は `design.md`、判断の根拠は `decisions.md`、前提となる実測事実は `research.md` にある。
この文書は**それを実行する順番と、各段階の完了条件**を書く。

段階ごとに動かして確認してから次へ進む。1 PR = 1 関心事。

---

## 段階 0 — 開発環境を整える

**骨組みまで書く。** 当初は「コードは書かない」としていたが、完了条件の `npm run check` は
`build` (= `wrangler deploy --dry-run`) を含み、これは `main` に指定した実体を要求する。
`/__scheduled` で Cron を叩く条件も実体が無いと満たせない。
そこで **404 を返す `fetch` と空の `scheduled`、UserScript の空のエントリ、
各 project にスモークテスト 1 本**までを置く。機能は段階 1 以降。

`.gitignore` と `CLAUDE.md` と `.github/` のテンプレートは個人標準の監査で先に入った。

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
wrangler.jsonc                  Cron / secrets.required (D1 と ratelimits は疎通確認で外した)
vitest.config.ts                projects を列挙する薄い root
vitest.worker.config.ts         cloudflareTest + readD1Migrations
vitest.userscript.config.ts     environment: jsdom
test/apply-migrations.ts        applyD1Migrations (疎通確認で外した。段階 3 で戻す)
scripts/build-userscript.mjs    esbuild の Build API
scripts/check-pr-title.sh       Conventional Commits の 9 type を検査
migrations/.gitkeep             (疎通確認で外した。段階 3 で 0001_init.sql と一緒に戻す)
.dev.vars.example               ローカルの秘密値のひな形 (.dev.vars は gitignore 済み)
src/worker/index.ts             404 を返す fetch と空の scheduled
src/shared/ids.ts               ph の桁数と検証。**両方の lib で型検査される**
src/userscript/index.ts         esbuild の入力になる最小のエントリ
test/env.d.ts                   (疎通確認で外した。テスト専用バインディングが無くなったため)
test/shared/ids.test.ts         **両 project の include に入れて 2 回走らせる**
test/worker/smoke.test.ts       404 / D1 接続 / secrets / DOM が無いことを workerd で
test/userscript/smoke.test.ts   DOM があること / UserScript のエントリを jsdom で
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
CLOUDFLARE_API_TOKEN=... npx wrangler d1 create cosense-grass
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
  "workers_dev": true,
  "triggers": { "crons": ["17 3 * * *"] },
  "secrets": { "required": ["WORKER_SECRET"] }
}
```

**バインディングと `secrets.required` は、使っているコードに合わせて足していく** (疎通確認で決めた)。
本番デプロイは `--dry-run` と違ってバインディングを実アカウントと照合するので、使っていないものを
宣言すると初回デプロイがそれで落ちうる。追加する予定は次のとおり。

```jsonc
// 段階 3 — wrangler d1 create した実 ID で
"d1_databases": [
  { "binding": "DB", "database_name": "cosense-grass",
    "database_id": "<UUID>", "migrations_dir": "migrations" }
],
// 段階 2 で Free プランでの可否を確かめてから
"ratelimits": [
  { "name": "INGEST_LIMITER", "namespace_id": "1001", "simple": { "limit": 60, "period": 60 } },
  { "name": "ENROLL_LIMITER", "namespace_id": "1002", "simple": { "limit": 5,  "period": 60 } }
],
// 段階 4 — Google サインインのコードと一緒に
"secrets": { "required": ["WORKER_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] }
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

**`test/shared/**/*.test.ts` を両方の project の `include` に入れる。** 同じ**テストファイル**が
workerd と jsdom で 2 回走り、shared が両環境で同じ答えを返すことを 1 つの検証で保証できる。
`include` はテストファイルの glob なので、source のパスを入れても拾われない。Worker が出す SVG と DOM 注入の草で配色が食い違わないこと
という設計の要求に、これが直接効く。

- `@cloudflare/vitest-plugin` からの import は**ルートから**。`/config` サブパスは存在しない
  (公式ドキュメントに古い記述が残っている)
- coverage は **istanbul**。V8 の native coverage は Workers plugin では使えない
- ストレージの分離はテストファイル単位。ファイルをまたいでデータは残らない
- **この 2 点は 1.1.8 で未再確認。** `isolatedStorage` オプションが schema から消えている
  (0.18 にはあった) ので、**D1 を本格的に使う段階 3 の前に確かめる**

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

- [x] `npm run check` がローカルで green (lint / typecheck / knip / test 19 件 / build)
- [x] `npm run dev` で Worker が起動し、**`/__scheduled`** で Cron を叩ける
      (`--test-scheduled` が公開する経路。`/cdn-cgi/handler/scheduled` と
      `/cdn-cgi/local/scheduled` でも走ることを実測したが、**文書化されているのは
      `/__scheduled`** なのでこちらを条件にする。research.md §5)
- [x] **認証なしで `dev` / `types --check` / `--dry-run` / `--local` のマイグレーションが動く**
      ことを実測した (`HOME` を空にして確認)。公式に明言が無いので測った
- [x] CI が PR で green になり、**必須チェック `ci` が ruleset に登録されている**
      (チェックが 0 件だと green と区別が付かない。`deploy` は条件付きでスキップするので
      required にしない — auto-merge が永久に pending になる)
- [x] `npx wrangler whoami` が**使いたいアカウント**を指している。
      プロファイルをメインのチェックアウトに束縛した (`wrangler auth create` / `activate`)

**段階 0 は完了。**

### 段階 0 で持ち越したもの

- **D1 とレート制限のバインディングは疎通確認で外した** (上記の規則)。
  段階 0 では D1 をプレースホルダの ID で置いていたが、本番デプロイで存在しない
  データベースを指すことになるため
- **`secrets.required` を宣言したので、テスト中に「Missing required secrets」の警告が出る。**
  `deploy --dry-run` は壊れない。**CI に秘密を置かない設計どおりの表示**で、失敗ではない。
  ローカルで消したいときは `.dev.vars.example` を `.dev.vars` にコピーする。
  なお `secrets` を宣言すると wrangler が `process.env` も参照するので、
  **シェルに同名の値を export しているとローカルのテストに静かに混ざる**
- **デプロイの guard は「必要なものが揃っているか」で判定する。** 当初はトークンの有無だけを
  見ていたが、それでは足りない。`secrets.required` を宣言しているので、**Worker が存在しない
  状態の `wrangler deploy` はアプリの secret が無いと必ず例外になる**
  (wrangler の secrets-validation をソースで確認)。トークンだけ登録した時点で main が
  赤くなるので、**`WORKER_SECRET` が揃っているかも guard で見る。**
  マイグレーションの段は別に `hashFiles('migrations/*.sql') != ''` で守っている
- **初回デプロイの経路は疎通確認で決めた。** CI が毎回 `--secrets-file` で渡す (ADR-0014 決定 7)
- **dependabot が wrangler を上げると `typecheck` が必ず落ちる。** 生成される
  `worker-configuration.d.ts` の先頭に `workerd@<版> <日付>` が入り、
  `wrangler types --check` がこの行を比較するため。**bump の PR では `npm run typegen` を
  回してから通す** (`wrangler` は exact pin にしてあるので、上がるときは必ず明示的)

---

## 段階 1 — SVG 生成と配色

**最も不確実な部分を最小コストで潰す。** ダミーデータで `/v1/g/demo.svg` を返し、
Cosense のページに実際に貼って表示を確認する。D1 は使わない。

### 最初の切片 — 疎通確認

本体に入る前に、**CI から本番へデプロイでき、Worker の SVG が Cosense で描画される**ことを
最小のコードで確かめる。どちらかが崩れると以降が手戻りになる。経路は完了条件と同じ
`/v1/g/demo.svg` なので、作ったものは捨てずに本体がその上に積む。

- `src/worker/svg.ts` — 53 週 × 7 日の格子に**仮の固定色**を並べる。セル 11px・間隔 3px は
  design §8 の実寸。**凡例はまだ無い** (design §8 の必須要件を満たさない。本体で入れる)
- `src/worker/index.ts` — `/v1/g/demo.svg` だけを返し、それ以外は 404
- CI の deploy — **毎回 `--secrets-file` で `WORKER_SECRET` を渡す** (ADR-0014 決定 7)

**範囲から外したもの。** `/v1/p.gif` は段階 3 の担当で、画像ビーコンの前提は research §1 で
実機検証済み。配色・四分位・凡例は本体。

**完了条件。** main へのマージで deploy が green になり、`curl -sI` が `200` と
`image/svg+xml; charset=utf-8` を返し、Cosense に貼った格子が表示されること。

**疎通確認は完了 (2026-09-13)。** 3 つとも確かめた。初回デプロイは `WORKER_SECRET` を
`--secrets-file` で渡して通り、本番の `curl -sI` が期待どおりのヘッダを返し、Cosense に貼った SVG が
表示された。**縦横比とダークテーマでの見え方は未確認**なので、本体で配色と凡例を入れるときに
Gyazo の証跡付きで確かめる (Issue #20)。

作るもの。

- `src/shared/scale.ts` 四分位スケール
- `src/shared/balance.ts` 読み書きのバランス
- `src/shared/oklch.ts` OKLCH から sRGB。彩度を二分探索でガモットに詰める
- `src/shared/scheme.ts` と `src/shared/schemes/` 配色の差し替え口と配色 (ADR-0016)
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
| `importKey("jwk", ...)` に Google の JWK をそのまま渡して通るか | ID トークン検証の実装が変わる。**`{kty, n, e}` だけを渡す形で本物の JWKS でも成立** (2026-09-14、#61) |
| **ポップアップから `postMessage` が scrapbox.io のプロジェクトページに届くか** | サインインが成立しない |
| `extractable: false` の `CryptoKey` を IndexedDB から読み戻せるか | Firefox で鍵が失われる |
| Rate Limiting binding が Free プランで使えるか | DoS 対策を WAF だけに寄せる |
| ポリシー URL 未設定のまま non-sensitive スコープのアプリを publish できるか | 公開の手順が変わる |
| no-op な UPDATE が rows written にカウントされるか | 書き込み予算の見積もりが変わる |

**結果は `research.md` に追記する。** 日付と出典を添えて、後から再検証できる形にする。

**2026-09-14 に記録の疎通確認 (#36) で 2 つを確かめた (Chrome)。** ECDSA P-256 のブラウザで sign → workerd で verify と、
`extractable: false` の `CryptoKey` を IndexedDB から読み戻して署名すること。Firefox は確かめていない (research §2・§5)。

### 送信の疎通確認 (2026-09-13 追加、Issue #31)

**Cosense のページで動く UserScript から、自分の Worker にデータが届くか**を確かめる。research §1 で確かめたのは
「scrapbox.io のコンソールから、外部ドメイン (placehold.co) へのクエリ付き画像 GET が通る」まで。
次は設計の前提なのに未確認で、崩れると段階 3〜6 が手戻りになる。

| 確認すること | 失敗したときの影響 |
|---|---|
| 配布ページからの `import` (ADR-0005) が、公開・非公開の両方のプロジェクトで動く | 配布方法が成立しない |
| 自分の Worker に届き、`onload` で到達を判定できる (ADR-0001) | 送信経路が成立しない |
| 中身が壊れずに届く (240 / 8,000 / 15,000 文字) | 送信の分割の設計が変わる |
| **Referer が届かない。** Cosense の Service Worker は画像を fetch し直す (research §3) ので、`no-referrer` が効くとは限らない | 非公開プロジェクト名とページ名が運営者のログに流れる |
| タブを隠したときの送信 (design §9 のトリガ) が届く | 当日分の送信トリガを変える |

作るもの。

- `src/worker/probe.ts` — 記録しない受け口 `GET /v1/probe.gif` (design §6)。観測した結果を GIF の幅で返す
- `src/userscript/index.ts` と `probe.ts` — ページメニューの「草: 送信の疎通確認」で 3 つの大きさを送る。
  タブを隠したときも読み込みごとに 1 回送り、結果をこのブラウザに残す。**送るのは乱数だけ**

**範囲から外したもの。** 記録 (段階 3)、署名 (段階 4)、センサー (段階 5)。タブを閉じたときの送信は
画像が中断される前提 (research §1) なので確かめない。

**完了条件。** 公開プロジェクトと非公開プロジェクトの両方で、メニューが出て、3 つの大きさがすべて
「届いた / 中身一致」、Referer なし、タブを隠したときの送信も「届いた」になること。
結果は research §1・§2 に日付とブラウザを添えて書く。証跡は Gyazo で Issue #31 に貼る。

**送信の疎通確認は完了 (2026-09-14、Chrome)。** 完了条件の「Referer なし」だけは崩れ、
「Referer にパスが含まれない」に置き換えて満たした。

- 配布ページからの import が、公開・非公開の両方のプロジェクトで動いた (research §2)
- 240 / 8,000 / 15,000 文字も、タブを隠したときも、すべて届いて中身が一致した
- **Cosense の Service Worker がページを制御していると Referer が届く。** 値はオリジンだけで、
  非公開プロジェクトの名前は流れない。受け入れた (ADR-0001 の 2026-09-14 の改訂、research §1)
- 残したこと。Chrome 以外のブラウザ、公開プロジェクトの制御下での Referer の形 (非公開と同じはず)
- 証跡はダイアログの文面を Issue #31 に書き写した。スクリーンショットは Gyazo に上げていない

---

## 段階 3 — D1 と記録の受け口

`GET /v1/p.gif` を実装する。Google サインインはまだないので、**署名は試験用の公開鍵 1 本で検証する**
(下の「記録の疎通確認」)。

作るもの。

- `migrations/0001_init.sql` スキーマ (`graphs` / `daily` / `daybits`。`users` と `keys` は段階 4)
- `src/shared/ids.ts` uid / ph / publicId の導出
- `src/shared/base64url.ts` と `src/shared/bits.ts` ビットマップの base64url 往復 / OR / popcount
- `src/shared/sign.ts` 署名対象の正規化
- `src/shared/beacon.ts` ビーコンの組み立てと厳密な読み取り
- `src/worker/ingest.ts` と `src/worker/merge.ts`
- `src/worker/cron.ts` 90 日より古い `daybits` の削除

テストで固定すること。ここが一番多い。

- **同じビーコンを 2 回送って値が変わらない** (冪等性)
- **2 つのプロジェクトで同じ分に活動したとき、`*` 行の `w` が 2 にならず 1 になること** (二重計上の回帰)
- `r & ~w` の排他
- `daybits` がない日に古いビーコンが来ても `daily.w` が減らないこと
- 未来の日と 30 日より古い日を拒否すること
- **署名が 64 バイトでなければ拒否すること。** DER を渡されたとき静かに `false` が返るのを防ぐ
- リプレイ窓の外を拒否すること
- 不正な `ph` (16 桁の 16 進数でも `*` でもない) を拒否すること
- `ids.ts` の uid が 27 文字であること。`ph` が uid でソルトされていること。
  プロジェクト別 publicId から uid も全体用 publicId も導けないこと

- **読みだった分が書きになっても合計が増えないこと** (w と r を別々に max で守ると二重に数える。ADR-0002 の改訂)
- **読んでから書くまでに別の送信が割り込んでも、ビットを失わないこと** (楽観的な書き込み)

### 完了条件

同じビーコンを 2 回送り、`daily` の値が変わらないこと。`wrangler d1 execute --local` で中身を確認する。
署名が要るので curl だけでは送れない。Node で署名した URL をローカルの `wrangler dev` に送る。

### 記録の疎通確認 (2026-09-14 追加、Issue #36)

**Cosense から送った活動が D1 に記録され、共有 SVG の格子に色として出る**までを端から端まで通す。
送信 (#31) と SVG の表示 (#20) に続く 3 本目の縦の切片。計画は Issue #36 のコメントにある。

| 決めたこと | 内容 |
|---|---|
| 書き込み権 | **試験用の公開鍵で署名する。** 鍵はブラウザで `extractable: false` で作り IndexedDB に置く。Worker は `wrangler.jsonc` の `TRIAL_PUBLIC_KEY` で検証し、空なら全部 403 |
| 試験用の uid | UserScript が 20 バイトの乱数を localStorage に作る。公開定数にすると `ph` を辞書で逆引きできる |
| D1 の作成 | CI の deploy ジョブが無ければ作る (ADR-0014 決定 9)。作った後に `database_id` を固定する |
| UserScript から送るもの | メニューから今日の固定パターンを、今のプロジェクトの `ph` と `*` の 2 エントリで送る |
| 反映の待ち時間 | `max-age=900` は変えない。確認用の URL には使い捨てのクエリを付ける (未知のキーは無視される) |

PR の順。

1. ビーコンの符号化と署名対象の正規化 (shared) — #38
2. 記録の受け口と D1 のスキーマ、Cron、CI の D1 作成 — #39
3. 共有 SVG を D1 から描く — #40
4. UserScript の「草: 記録の疎通確認」 — #41
5. 公開鍵と `database_id` を設定に入れる — #42
6. 結果の記録 (この節の末尾)

**範囲から外したもの。** Rate Limiting (段階 2 の未検証事項)、enroll / revoke / delete、`users` と `keys` のテーブル、
30 日無送信のログ。

~~**段階 4 でやること。** 試験用の公開鍵と、試験で書いたデータを消す。~~ **段階 4 を待たずに消した** (2026-09-14、Issue #54)。
段階 4 は外部の準備 (OAuth クライアント・独自ドメイン) 待ちなので、どの uid にも書ける鍵を先に閉じた。

1. 受け口が `keys` テーブルを (uid, kid) で引くようにし、`TRIAL_PUBLIC_KEY` を消した (`migrations/0002_keys.sql`、#56)。
   登録 (段階 4) がまだ無いので、本番の記録は全部 403 になる
2. その次のデプロイで `graphs` / `daily` / `daybits` を条件なしで消した (`migrations/0003_delete_trial_data.sql`)。
   1 と同じデプロイにすると、マイグレーションからデプロイまでの間に古いコードが書き直せる

**ローカルの確認 (2026-09-14、PR 2)。** `.dev.vars` にテスト用の公開鍵を置いた `wrangler dev` に、Node で署名した
ビーコン (合算とプロジェクトの 2 エントリ、1,224 文字) を 2 回送った。1 回目は幅 17、2 回目は幅 16 で、
`wrangler d1 execute --local` で見た `daily` は 2 行とも w = 5 / r = 10 / pages = 1 のまま変わらなかった。
ログは `{"event":"ingest","status":200,"reason":"written","entries":2,"changed":2}` と `"unchanged"` の 2 行で、uid は出ていない。

**Cosense での確かめ方 (PR 4 以降、持ち主)。** ページメニューの「草: 記録の疎通確認」を使う。

1. 配布ページ (当時は持ち主の個人プロジェクト。今は `/cosense-grass/dev`) にバンドルを貼り、自分のページで「草: 記録の疎通確認」を押す。鍵 (IndexedDB) と試験用の uid (localStorage) が
   作られる。公開鍵が未登録なので結果は「届かなかった」になる。ダイアログとコンソールに出た**公開鍵** (87 文字) を控える
2. 公開鍵を `wrangler.jsonc` の `TRIAL_PUBLIC_KEY` に入れてデプロイする (PR 5)
3. **ページを再読み込みしてから**もう一度押す。「鍵: IndexedDB から読み戻した」「結果: 書いた (幅 17)」になること。
   続けて押して「変化なし (幅 16)」になること。再読み込みを挟むのは、`extractable: false` の `CryptoKey` を IndexedDB から
   読み戻して署名できるか (段階 2 の未確認事項) も確かめるため
4. ダイアログの「合算の草」と「このプロジェクトの草」の URL を Cosense のページに `[ ]` で貼り、今日のマスに色が出ること。
   同じ URL を 15 分以内に読み直すときは使い捨てのクエリ (`?r=2`) を付ける
5. 送るのは今日の固定パターン (0:00〜0:04 を書き、0:00〜0:14 を読み)。**プロジェクト名は送らない** (URL に載るのは ph だけ)

**記録の疎通確認の結果 (2026-09-14、Chrome、持ち主のプロジェクト)。** Worker と UserScript の区間は端から端まで通った。
Cosense のページに貼ったときの見た目だけ、まだ確かめていない。

| 時刻 (JST) | 操作 | ダイアログ |
|---|---|---|
| 14:45 | 公開鍵を登録する前に押す | 「★届かなかった」、鍵「新しく作って IndexedDB に保存した」。本番は 403 を返していた |
| — | 公開鍵と `database_id` を入れてデプロイ (#42) | |
| 14:51 | 押す | **「書いた (幅 17)」**、鍵「IndexedDB から読み戻した」 |
| 14:53 | もう一度押す | **「変化なし (幅 16。同じ中身は 2 回目から書かない)」** |

- **Cosense から送った活動が D1 に記録された。** 幅 17 は Worker が D1 の batch を書いたときだけ返る
- **同じ活動を 2 回送っても値が変わらなかった。** 2 回目は Worker が変化なしと判定し、書き込みの batch を送っていない
- **記録した日が共有 SVG の格子に色として出た。** 14:51 の記録の後に、合算とプロジェクト別の SVG を取得して中身を数えた
  - どちらも `200 image/svg+xml` で、365 マス中、色付きは右端の列の月曜 (= 今日の 9/14) の 1 マスだけ。色は `#ddd6fe`
  - 残りの 364 マスは Level 0 の `#ebedf0`。右端の列が月曜で終わるので、「今日」を日本時間で決めていることとも合う
  - 記録が 1 日だけなので、四分位は Level 1、バランスは中心 (青 → ピンクの真ん中の紫) になる
- **ECDSA P-256 の往復が本番で成立した。** ブラウザ (Chrome) の `crypto.subtle.sign` で署名し、workerd の `verify` が通った
- **`extractable: false` の `CryptoKey` を IndexedDB から読み戻して署名できた** (Chrome)。14:45 に作った鍵を 14:51 と 14:53 に
  読み出した。押すたびに IndexedDB を開き直して読むので、メモリ上の鍵を使い回したのではない。ページの再読み込みを挟んだかは記録していない
- 公開鍵は 87 文字の正規な base64url で、kid はダイアログの値と一致した。**草の URL (publicId) とプロジェクト名は記録に残さない**

**残したこと。**

- **Cosense のページに `[ ]` で貼ったときの見た目** (ライト・ダーク)。確かめずに #36 を閉じた。応答のヘッダはデモ (#20 で表示を確認済み) と同じ `svgResponse` から出ていて、中身は上のとおり SVG を数えて確かめた
- Chrome 以外のブラウザ。特に Firefox の IndexedDB の読み出し (bug 1348279)
- Workers Logs に URL が残るか (invocation logs を切る前の probe の `d=`)。ADR-0013 の 2026-09-14 の改訂の根拠になる
- no-op な UPDATE が rows written に数えられるか。受け口は変化の無い書き込みを送らないので、この確認では測れない

**自動送信の確認 (2026-09-14 追加)。** 上の確認は、送信のきっかけがメニューのクリックだった。センサー (段階 5) はクリック無しで送るので、
その前提を段階 5 の前に確かめる。

| | 確認済み | 未確認だったこと |
|---|---|---|
| 操作なしで画像ビーコンが届く | #31 (タブを隠したときに乱数を送った) | — |
| 自動のきっかけで、IndexedDB を開く → 署名 → 送る、を最後までやり切れる | — | ここで確かめる |
| ページ読み込み時の送信 (design §9 の主経路) | — | ここで確かめる |

試しの UserScript に、次の自動送信を足した。

- **ページを読み込んだとき**と**タブを隠したとき**に、それぞれ読み込みごとに 1 回、メニューと同じ固定パターンを送る
- 結果はこのブラウザの localStorage (`cosense-grass:record:auto`) に残し、メニューのダイアログに出す。
  出すのは、結果・プロジェクト名・時刻・Service Worker の制御状態・きっかけから結果までの時間
- 中身が同じなので、結果は「変化なし (幅 16)」になり、D1 の値は増えない。**幅 16 は Worker が署名を検証した後にしか返らない**ので、
  自動で「鍵を読む → 署名 → 届く → 検証が通る」まで成立したことの証明になる
- 記録の送信は 1 本の列に並べる。読み込み時・タブを隠したとき・メニューが重なっても、初めてのブラウザで鍵を 2 本作らない
- 試しのバンドルを import した他人のブラウザでも送られるが、その鍵は未登録なので 403 になり D1 には書かれない。
  **段階 5 でセンサーに置き換えるときに、この自動送信は消す** (2026-09-14、#49 で消した)
- タブを閉じたときの送信は確かめない。画像リクエストは中断される前提 (research §1、ADR-0002)

確かめ方 (持ち主)。

1. 配布ページにバンドルを貼る
2. 自分のページを開き直す (読み込み時の自動送信が走る)
3. 別のタブに切り替えて戻る (タブを隠したときの自動送信が走る)
4. 「草: 記録の疎通確認」を押す。「自動送信 (読み込み時)」「自動送信 (タブを隠したとき)」がどちらも「変化なし (幅 16)」になっていること

**自動送信の結果 (2026-09-14、Chrome、#44)。** クリック無しで、署名つきの記録が最後まで通った。
**Service Worker の制御外と制御下の両方で成立した。**

| 開き方 | きっかけ | 時刻 (JST) | 結果 | Service Worker | きっかけから結果まで |
|---|---|---|---|---|---|
| 強制再読み込み | 読み込み時 | 15:23:51 | 変化なし (幅 16) | 制御外 | 1.3 秒 |
| (同上) | タブを隠したとき | 15:23:53 | 変化なし (幅 16) | 制御外 | 0.1 秒 |
| **通常の再読み込み (Cmd+R)** | 読み込み時 | 15:26:35 | 変化なし (幅 16) | **制御下** | 0.8 秒 |
| (同上) | タブを隠したとき | 15:26:36 | 変化なし (幅 16) | **制御下** | 1.2 秒 |

- **design §9 の送信トリガのうち、ロード時とタブを隠したときが成り立つ。** 設計を変える必要は無い
  - 幅 16 は Worker が署名を検証した後にしか返らない。なので、どの行も「IndexedDB から鍵を読む → 署名 → 届く → 検証が通る」まで成立した
- **制御下でも届き、応答の幅も読めた。** 制御下では Cosense の Service Worker が画像リクエストを作り直す (research §1)。
  署名つきの記録の URL (約 1,240 文字) も壊れずに届いた (壊れていれば署名の検証で 403 になる)
- 所要時間は 0.1〜1.3 秒。タブを隠した直後でも、IndexedDB を開いて署名するまでの非同期の処理がやり切れた
  - 1 秒前後は、読み込み時の送信やページ自体の読み込みと重なった分を含む。所要時間はきっかけからの時間で、列で待った時間も入る
- 確かめていないもの
  - 日付の変更をきっかけにした送信
  - タブを閉じたとき (中断される前提)
  - 長くバックグラウンドにあって凍結されたタブ
  - Chrome 以外のブラウザ
  - 段階 6 (実データで 1 週間) で見る

**メニューの撤去 (2026-09-14、Issue #54)。** Worker が試験用の公開鍵を受け付けなくなった (#56) ので、「草: 記録の疎通確認」と
`src/userscript/record.ts` (試験用の uid と IndexedDB の鍵) を消した。送信の疎通確認 (#31) のメニューは残す。

持ち主のブラウザに残ったものは UserScript では消さず、手で消す (残っても Worker が受け付けないので無害)。

| 置き場 | 消すもの |
|---|---|
| localStorage | `cosense-grass:trial:uid` (試験用の uid)、`cosense-grass:record:auto` (自動送信の結果。#49 から更新されない) |
| IndexedDB | `cosense-grass` (DB ごと。段階 4 の前なので本物の鍵はまだ無い) |

`cosense-grass:probe:hidden` は送信の疎通確認が使い続けるので残す。

---

## 段階 4 — Google サインインとデバイス登録

- `src/worker/auth.ts` `/auth/start` と `/auth/callback`。**入れた** (2026-09-14、Issue #61)。ブラウザで `https://grass.soui.dev/auth/start` を
  開けば 48 文字のコードが表示される。cookie は `auth-cookie.ts`、ポップアップの HTML は `auth-page.ts`、コードは `src/shared/auth.ts`
- `src/worker/idtoken.ts` ID トークンの検証と JWKS の保持、`src/worker/uid.ts` sub から uid を導く。
  **OAuth クライアントを待たずに先に入れた** (2026-09-14、Issue #61)。使う経路 (callback) はまだ無い
- `src/worker/enroll.ts` デバイスの登録と失効。**登録 (`/v1/enroll.gif`) と登録トークンの発行を先に入れた** (2026-09-14、Issue #61)。
  トークンを発行する callback がまだ無いので本番では 403。失効はまだ
- `src/userscript/keys.ts` この端末の鍵と uid を IndexedDB に 1 レコードで持つ。**入れた** (2026-09-15、Issue #61)。キーは `device` で、
  記録の疎通確認のキー `trial` は読まない
- 受け口 (`src/worker/keys.ts`) は `keys` テーブルを引く形にしてある (#56)。**enroll が `keys` に行を入れれば記録が通る**
- `src/userscript/auth.ts` ポップアップ、`postMessage` とコードの貼り付けの受信、登録。**入れた** (2026-09-15、Issue #61)。
  メニューは「草: サインインしてこの端末を登録」、ダイアログは `sign-in-dialog.ts`

テストで固定すること。

- **`iss` の 2 形式を許容すること。** `https://accounts.google.com` と `accounts.google.com`。
  自前実装でよく落ちる
- `alg` が RS256 以外なら拒否すること。`none` や HS256 の混入を弾く
- `nonce` の不一致を拒否すること
- 未知の `kid` で JWKS を 1 回だけ再取得すること
- 登録トークンが 1 回使い捨てで 5 分で切れること (#61 で固定した。同時に 2 回送っても通るのは 1 回)

~~外部への fetch のモックは `@msw/cloudflare` を使う。~~ **msw は入れない** (2026-09-14、Issue #61)。
JWKS の取得関数を注入し、テストでは Google と同じ形の応答を返す関数を渡す。依存を増やさずに取得の回数まで数えられる。
`fetchMock` は現行ではない。

### 確かめ方 (持ち主)

1. `npm run build` の `dist/userscript.js` を `/cosense-grass/dev` の `code:script.js` に貼り、ページを開き直す
2. メニュー「草: サインインしてこの端末を登録」→ ポップアップでアカウントを選ぶ → ポップアップが閉じ、
   「この端末を新しく登録しました」「受け取った経路: ポップアップ」、kid、合算の草の URL が出る (postMessage が届いたことも分かる)
3. 合算の草の URL を開いて SVG が表示される (まだ送信しないので空の草)
4. ページを再読み込みしてもう一度サインイン → 「登録済み」で kid が同じ (IndexedDB から鍵を読み戻して署名できた)
5. ダイアログの「別のタブでサインインを開く」でサインインし、出たコードを貼って Enter → 「登録済み」「受け取った経路: コードの貼り付け」。
   同じコードをもう一度貼ると「登録できませんでした」
6. **2 台目** (別の PC か別のブラウザ。できれば Firefox) で同じ Google アカウント → 「新しく登録しました」で **kid は違い、合算の草の URL が 1 台目と同じ**
   (publicId は uid から導くので、URL が同じなら uid が同じ)

結果はこの節に日付とブラウザを添えて書き、#61 にもコメントする。

### 完了条件

2 台のデバイスから同じ Google アカウントでサインインし、**同じ uid になって同じ草に合流すること。**
COOP のフォールバック (コードを貼る経路) も実際に試す。

草への合流そのものは送信 (段階 6) が入ってから見える。段階 4 では合算の草の URL が同じになることで uid の一致を確かめる。

---

## 段階 5 — センサーとビットマップ

**段階 4 より先に入れる** (2026-09-14、Issue #49)。段階 4 は Google Cloud の OAuth クライアントが無いと通せず、
段階 5 は外部の準備が要らない。完了条件が「1 日使う」なので、早く入れるほど観察の時間が取れる (design §12)。
計画は Issue #49 のコメントにある。

送信せず、ページメニューの「草: センサーの記録」で挙動を確認する。

- `src/userscript/sensor.ts` 20 秒ポーリングと `lines:changed`。数えるプロジェクトの判定
- `src/userscript/store.ts` localStorage (ビットマップと集計値)
- `src/userscript/index.ts` 常駐とマウント。**記録の疎通確認の自動送信は消した** (メニューも #54 で消した)
- `src/userscript/report.ts` 「草: センサーの記録」の文面
- ~~`src/userscript/beacon.ts` 画像 GET と署名~~ **段階 6 に移した。** 送る uid が段階 4 まで無い

PR の順。

1. 本体の UserScript API を読み直した結果を research §2 に記録する — #50
2. localStorage の記録 (`store.ts`) — #51
3. センサーと配線、確認用のメニュー、docs
4. 新規作成 (`created`) の検出 — 実機で前提を確かめてから

**読み直しで前提が 1 つ崩れた。** 配布モジュールは 1 ドキュメントで 1 回しか評価されず、アプリ内でどのプロジェクトへ
移っても動き続ける。センサーは自分のページの `script.js` を読んで、1 行があるプロジェクトだけを数える (ADR-0007 決定 5 の改訂)。

確認すること。

- **`by === "edit"` で他人の編集を弾けているか。** 共同プロジェクトで他の人に編集してもらう
- `document.hasFocus()` が効いているか。タブを裏に回して数えないこと
- bit がプロジェクト行と `*` 行の両方に立つこと。**合算は各行の OR から数えるので、構造的に成り立つ** (テストで固定した)
- 複数タブで localStorage を共有していること
- ~~プロジェクトを移動したときに再注入されて動き続けること~~ **再注入されない (評価は 1 回)。**
  移動して戻っても数え続けること、**1 行の無いプロジェクトへアプリ内で移ったら数えないこと**

確かめ方 (持ち主)。

1. `npm run build` の `dist/userscript.js` を `/cosense-grass/dev` の `code:script.js` に貼る
2. ふだんどおり 1 日使い、ときどき「草: センサーの記録」を押す。**今日の区間** (`9:02–9:16 読み 14 分` の形) が実感と合うか見る
3. タブを裏に回した間、別のアプリにフォーカスを移した間の区間が無いこと
4. 2 つのプロジェクトで使い、合算の分がプロジェクト別の和以下になること
5. 同じプロジェクトを 2 タブで開いて交互に使い、記録が消えないこと
6. import の 1 行が無いプロジェクトへリンクをたどって移り、メニューが「数えていない」になること。元のプロジェクトに戻って「数えている」になること
7. 共同編集者か別の Google アカウントに同じページを編集してもらい、自分の書きに数えないこと

結果はこの節に日付とブラウザを添えて書く。証跡 (メニューの文面) は Issue #49 に貼る。

### 完了条件

1 日使って、localStorage の日次集計が実感と合うこと。分バケットが過大でも過小でもないこと。

---

## 段階 6 — 接続

段階 3 から 5 を繋いで実データで 1 週間動かす。

- `src/userscript/beacon.ts` 画像 GET と署名 (段階 5 から移した)。localStorage の `bits` から未送信の日を選び、
  プロジェクト名から ph を導いて送る。**`src/shared/beacon.ts` と名前が衝突するので、`outbox.ts` (選ぶ) と `sender.ts` (送る) に分けた**
  (2026-09-15、Issue #67)
  - PR の順: `outbox.ts` (#68) → **`sender.ts` と配線** (読み込み時・日付の変更・隠したとき・登録の成功) → 「草: センサーの記録」に送信の状況を出す
  - **タブを隠したときの送信の疎通確認の自動送信は消した。** 持ち主のブラウザに残る localStorage `cosense-grass:probe:hidden` は手で消す
  - 配布ページに貼るのは、送信の状況をメニューで見られるようになってから。**「草: センサーの記録」に送信の状況を出した** (2026-09-15)

確かめ方 (持ち主)。

1. `npm run build` の `dist/userscript.js` を `/cosense-grass/dev` に貼り、ページを開き直す。localStorage の `cosense-grass:probe:hidden` は手で消す
2. 登録済みのブラウザ A で、プロジェクト P と Q で数分ずつ読み書きしてタブを隠す → ページメニュー「cosense-grass」の
   状態行が「このブラウザの記録は送信済みです」「最後に送ったのは HH:MM (タブを離れたとき)」になる
   (2026-09-15、Issue #102 で「草: センサーの記録」のメニューから移った)
3. すぐもう一度隠す → 変化が無ければ回数が増えない
   (「今すぐ送る」を押しても「送るものはありませんでした」)
4. ブラウザ B (同じアカウントで登録済み) で、A と**同じ時刻の分**と違う時刻の分を作って隠す
5. 合算の草の URL に `?r=<任意>` を付けて開き、今日のマスに色が出る。**重なった分が二重に数えられていない** (A と B の分数の和より少ない)。
   ダイアログの「今すぐ送る」を押した直後にも、同じクエリで統合の草が描き直される
6. 翌日の最初の読み込みで「読み込み時 — 書いた / 変化なし」。タブを開いたまま日付を越えたら「日付の変更」
7. Workers Logs の `event:"ingest"` が `status:200` (`written` / `unchanged`) で、`unknown-key` や `time-window` の 403 が出ていない
8. 1 週間続け、D1 の rows written を design §11 の見積もりと比べる

結果はこの節に日付とブラウザを添えて書き、#67 にもコメントする。

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

### 草のダイアログ (2026-09-15 着手、Issue #73)

設定 UI より先に、合算とプロジェクト別の草を Cosense の中で見られるようにする。**ページに挿さずダイアログにした** (ADR-0003 の 2026-09-15 の改訂)。

- PR の順: **全端末を統合した草を `<img>` で並べる** (`viewer.ts`・`graph-dialog.ts`、#75) → 草のレイアウトを `svg.ts` から `src/shared/` へ分ける (#76) → このブラウザの記録を描いてツールチップを出す (`render.ts`)
- このブラウザの記録を描いてツールチップを出す (#77)。**持ち主が手元で確認した** (2026-09-15、#73)
- 残り: ダイアログをページのテーマに合わせる (#81)、ページの見た目 (#92)。
  「設定」(#79) と「ここから計測開始」の印 (#80) は済み
- **ページメニューを 1 項目に畳んで `v1` を配れる形にした** (2026-09-15、Issue #95)。
  `USERSCRIPT_VERSION` は `1.0.0`。**`dev` で確かめてから `v1` にも貼った** (2026-09-15、手元の `cosense` CLI。
  ADR-0013 決定 3 の改訂)。どちらも配信されている中身が手元の `dist/userscript.js` と SHA-256 で一致する
  (Cosense は行の配列なので、末尾の改行だけ無い)
- 段階 6 の確かめ方の手順 4 (プロジェクト別の草) も、このダイアログで見られる
- **統合の草を主にし、このブラウザの記録は `<details>` に畳んだ** (2026-09-15、Issue #101。ADR-0003 の改訂)。
  対等に並べると同じ形の草が最大 12 枚並び、値が違うときにどちらが本当かが読めなかった。
  **あわせてページメニューの名乗りを `cosense-grass` に変え**、ダイアログの中の「草の設定」は「設定」に縮めた。
  このとき**合算の草も「送れたか」で判定するようにした** (#100)。決め打ちだったので、登録しただけで
  まだ送っていないブラウザでは主役の位置に 404 の絵が出ていた
- **未送信の差分と「今すぐ送る」を入れた** (2026-09-15、Issue #102。ADR-0010 の改訂)。
  統合の合算の草の直後に状態行を置き、前日以前の未送信だけを警告として出す
  (今日はほぼ常に未送信なので分けた)。自動で送っていることも同じ場所に書いて、普段は押す必要がないと示す
- 残り: #81 (テーマ) と #92 (ページの見た目)。どちらも同じ面を触る

### 「設定」(2026-09-15 着手、Issue #79)

草のダイアログから開く「設定」(`settings.ts` がモデル、`settings-dialog.ts` が DOM。草のダイアログと同じ分け方)。
**名前は #101 で「草の設定」から縮めた** (入れ子の「cosense-grass」→「設定」で十分に指せる)。

- PR の順: **ダイアログの器・サインインの集約・read 計上の on/off** (#84、済み) →
  **この端末の失効** (`/v1/revoke.gif`、済み) → **全データの削除** (`/v1/delete.gif`・`admin.ts`、済み) →
  **ほかの端末の一覧と失効** (Worker の `/account`、済み。ADR-0017)
- **管理はページへ集約した** (ADR-0018、Issue #88)。Cosense 側はそのブラウザでしかできないことだけにし、
  `/` (トップ)・`/account` (管理)・`/privacy` (ポリシー) の 3 枚を用意した
- **失効は `keys` の行の削除**で、列は足さない。登録し直すには ID トークンが要る
- **全削除は uid を持つ 5 つの表を 1 回の batch で消す。** 表を足したら `account.ts` の `TABLES` にも足す
- **サインインは単独のメニューをやめ、ここに集約した** (design §9)。**ページメニューに足すのは
  「cosense-grass」の 1 項目だけで、「設定」はそのダイアログの下のボタンから開く** (2026-09-15、Issue #95・#101)。
  開発用だった「草: センサーの記録」と「草: 送信の疎通確認」は、v1 を配るのに合わせてコードごと消した
- **read 計上を off にしても書きは数える。** センサーは数えるたびに設定を読み直す
- **デバイスの一覧はこのダイアログに出せない** (CSP に受信方向が無く、UserScript からサーバの `keys` を読めない)。
  この端末の kid だけを出し、ほかの端末は Worker の `/auth/devices` で扱う (ADR-0017)

---

## 外部に用意するもの

段階ごとに必要になる順。**これは手を動かす作業で、コードでは代替できない。**

| いつ | 用意するもの | 備考 |
|---|---|---|
| 段階 0 | **認証プロファイルの束縛** | 使いたいアカウントで `wrangler auth create` / `activate`。`whoami` で確認 |
| 段階 1 | **CI 用の API トークン** | account-owned token。「Edit Cloudflare Workers」+ **Account > D1 > Edit**。KV / R2 / Tail は落とす。対象アカウント 1 つに限定。TTL を設定 |
| 段階 0 | **Environment secrets** | `production` 環境に `CLOUDFLARE_API_TOKEN` を置く。**deployment branch を main に限定。required reviewers は付けない** (自動デプロイが止まる)。`CLOUDFLARE_ACCOUNT_ID` は不要 (`account_id` が設定にある) |
| 疎通確認 | **`WORKER_SECRET`** | `production` の Environment secrets に置く。`openssl rand -hex 32` で作り 1Password 等に控える。**初回デプロイはこれが無いと必ず失敗する** |
| 段階 1 | Cloudflare アカウント | 無料枠。D1 はまだ不要 |
| 段階 1 | Cosense の確認用ページ | 自分のプロジェクトのどこかに 1 ページ |
| 段階 3 | D1 データベース | **CI の deploy ジョブが無ければ作る** (ADR-0014 決定 9)。CI 用トークンに **Account > D1 > Edit** が要る。作った後に `database_id` を `wrangler.jsonc` に固定する |
| 段階 4 | **独自ドメイン** | **用意済み (2026-09-14、`grass.soui.dev`)。** ダッシュボードの Custom Domain で付け、`wrangler.jsonc` に `routes` を書かない (ADR-0014 決定 10)。`workers.dev` では zone の WAF が効かず、レートリミットがかけられない |
| (同上) | **`WORKER_SECRET` は変えられない** | uid の導出鍵。**変えると全利用者の識別子が変わり、失うと再計算できない。必ずバックアップ** |
| 段階 4 | Google Cloud の OAuth クライアント | **用意済み (2026-09-14)。** ID は `wrangler.jsonc` の `vars`、secret は `production` の Environment secrets (`GOOGLE_CLIENT_SECRET`)。リダイレクト URI は `https://grass.soui.dev/auth/callback`。**同意画面はテスト中で、ブランディングは未設定** (プライバシーポリシーの配信と一緒に対応する)。テスト中はテストユーザーに入れたアカウントだけがサインインできる。`openid` スコープのみなら審査は不要 |
| 段階 4 | プライバシーポリシーの公開先 | **用意済み (2026-09-15、`https://grass.soui.dev/privacy`)。** `docs/privacy.md` を正本のまま配信する (ADR-0018)。次は同意画面のブランディング |
| 段階 5 | **Cosense の配布用公開プロジェクト** | **用意済み (2026-09-14、[`/cosense-grass`](https://scrapbox.io/cosense-grass/))。`v1` を公開した (2026-09-15)。** ページは `dev` (開発版) と `v1`… (リリース版)。**`dev` と `v1` には同じバンドルを貼る** (2026-09-15、Issue #95。ADR-0005 の改訂)。貼るのは手元の `cosense` CLI で、CI では自動化しない (ADR-0013 決定 3 の改訂)。メンバーは持ち主だけ |
| 公開時 | Bot Fight Mode を OFF | JS 実行を要求するチャレンジは画像ビーコンを静かに壊す |

---

## 保留している判断

- **`docs/decisions.md` を `docs/decisions/NNNN-<slug>.md` に分割するか。** 個人標準は
  ディレクトリ分割を要求しているが、いまは単一ファイルに収まっている。分割すると相互参照のリンクが増える。
  **段階 0 では触らず、ADR が 20 件を超えたら分割する。**
  件数は `grep -c '^## ADR-' docs/decisions.md` で数える (**本文に書かない**。足すたびにずれる。#37)
- 週次の外部リンク死活検査ワークフロー。`check-links.sh` が意図的に外部 URL を見ないので、
  別途必要になる。ただし required にしない。**段階 8 の後**
- `.github/repo-settings.json` による GitHub 設定のコード化。**段階 0 では採らなかった。**
  設定は個人標準の監査で `gh` コマンドから当て、何をなぜ変えたかは PR #11 の本文に残した。
  定義ファイルを採るなら当てた内容を移して正本を 1 つにする必要があり、
  1 リポジトリだけの実践を先に入れる理由が無かった。**再検討は Issue #10**
- 配布の自動化。Personal Access Token はスコープがなくアカウント全体にアクセスできるので、
  CI の Secrets に置かない。**リリース頻度が上がったら再検討**
