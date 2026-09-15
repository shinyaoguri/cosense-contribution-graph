# CLAUDE.md

Cosense (旧 Scrapbox) の活動を草として可視化する。成果物は **UserScript** (センサー兼ビューア) と
**Cloudflare Worker + D1** (記録と SVG 配信) の 2 つ。Worker は作者が 1 つホストして公開提供する。

**段階 3 (D1 と記録の受け口) まで実装し、段階 5 (センサー) を段階 4 より先に入れている** (#49。段階 1 の本体は #23 が開いたまま)。
センサーは localStorage に記録する。受け口は `keys` テーブルの鍵で検証する (#54)。
段階 4 (#61) は Worker の `/auth/*`・`/v1/enroll.gif` と、UserScript の「草: サインインしてこの端末を登録」まで入れた。
段階 6 (#67) で、登録した鍵で署名して送る処理 (`sender.ts`) を入れている。
段階 8 (#73) は、ページメニュー「草を見る」のダイアログに、全端末を統合した草 (共有 SVG の `<img>`) と、このブラウザの記録から描いた草 (ツールチップ付き) を、それぞれ合算とプロジェクト別に並べている。
本番は `https://grass.soui.dev` (独自ドメイン。`cosense-grass.soui.workers.dev` も有効) で、デモの草 `/v1/g/demo.svg` がある。設計の正本は `docs/`。

## docs の読み方

| | 役割 |
|---|---|
| `docs/decisions.md` | ADR。**最初に読む。** 送信経路と身元の紐づけが素朴な設計と違う理由がここにある |
| `docs/design.md` | 設計。指標・スキーマ・API・配色・脅威モデル |
| `docs/research.md` | 実測事実。**基準日と出典が付いている。推測で上書きしない** |
| `docs/roadmap.md` | 実装順と段階ごとの完了条件。どこまで進んだかもここにある |
| `docs/privacy.md` | プライバシーポリシーの草案 |

設計判断を変えるときは ADR を足すか、既存 ADR に改訂を書く。**ADR が 20 件を超えたら
`docs/decisions/` へ分割する** (現在 15 件。それまでは単一ファイルのまま)。

## 検証

```sh
npm run check                # push 前のゲート。lint → typecheck → knip → test → build
npm run lint:fix             # biome の自動修正 (import の並びもここで直る)
npm run dev                  # wrangler dev。/__scheduled で Cron を叩ける
./scripts/check-links.sh     # Markdown の相対リンクが実在するか
```

**CI も `npm run check` を呼ぶ**ので乖離しない。**Cloudflare の認証情報なしで green になることが
不変条件** (Workers のテストはローカルの workerd だけで走る)。

**`check-links.sh` は外部 URL を見ない。意図的。** 一次情報への出典を大量に持つので、到達性を CI で
見ると先方の都合で赤くなる。出典の鮮度は `research.md` の基準日付きの記述で人間が管理する。
外部を見るのは配布ページの見張り (`distribution.yml`、Issue #47) だけで、これも required にしない。

テスト中の「Missing required secrets」は**設計どおりで失敗ではない** (`secrets.required` を宣言していて、
CI に秘密を置かない)。ローカルで消したいときは `.dev.vars.example` を `.dev.vars` にコピーする。

## 触るときの注意

### デプロイをローカルから打たない

**`wrangler deploy` / `d1 ... --remote` / `secret put` は GitHub Actions からだけ。** ローカルの
`npm run` に並べない (ADR-0014)。複数の Cloudflare アカウントがあり、非対話実行は先頭を黙って
選ぶので、どのアカウントに向いているか分からないまま実行する事故を防ぐ。

**`CLOUDFLARE_API_TOKEN` をローカルに置かない。** この変数はすべての認証プロファイルを上書きする。
rc ファイルにも `.env` にも書かない。ローカルは `wrangler auth activate` でこのディレクトリに
プロファイルを束縛する。

### `wrangler d1` の既定はローカル

**フラグ省略時の既定はローカル。公式ドキュメントは「`--local` なしならリモート」と書いているが
実装と逆** (`research.md` で実測済み)。`--local` / `--remote` を常に明示する。

### Cosense の CSP から外へは送れない

`connect-src` が許可リストなので **`fetch` も `sendBeacon` も使えない。** 送信は `img-src *` を
通る画像 GET ビーコン。日次ビットマップを毎回全量送り、サーバは OR でマージする (ADR-0001、0002)。
受信方向は存在しないので、統合された草は共有 SVG を `img` で見る。

### 識別子の桁数

| | 値 |
|---|---|
| `uid` | HMAC-SHA256 の先頭 160 bit を base64url にした **27 文字** |
| `ph` | `SHA-256(uid + ":" + プロジェクト名)` の先頭 **16 桁**。`*` は全体の予約値 |
| `publicId` | `SHA-256(uid + ":" + 対象)` の先頭 **32 桁** |

`uid` は全行に出るので行サイズに直接効く。短縮した経緯は ADR-0013 決定 2 にある。

### 生成物と設定の細かい約束

- **`worker-configuration.d.ts` はコミットする。** `wrangler types --check` が差分を見るため。
  **wrangler を上げたら `npm run typegen` を回す** (でないと `typecheck` が落ちる)
- **バインディングと `secrets.required` は使うコードと一緒に足す** (ADR-0014 決定 8)。
  本番デプロイは実アカウントと照合するので、使っていないものを宣言すると初回デプロイで落ちうる。
  **足したら `npm run typegen`**
- **knip の `ignoreDependencies: ["cloudflare"]` は消さない。** `cloudflare:test` という
  仮想モジュールを `cloudflare` という実パッケージだと誤認するため
- **biome は `worker-configuration.d.ts` を見ない** (生成物で 15,000 行あるため)
- **`vars` は `wrangler.jsonc` が正本。** ダッシュボードで足してもデプロイのたびに消える。
  **`secrets.required` に足したら `.github/workflows/ci.yml` の guard と `names` も足す** (でないとデプロイが落ちる)
- **`wrangler.jsonc` に `routes` を書かない。** 独自ドメインはダッシュボードの Custom Domain で付けている。
  1 つでも宣言するとデプロイが宣言に無いカスタムドメインを外し、CI 用トークンにもゾーンの権限が要る (ADR-0014 決定 10)
- **`npx wrangler deploy --dry-run` を直接打たない。** `.claude/settings.json` の deny が
  `wrangler deploy` を前置マッチで止めるので `--dry-run` も止まる。**`npm run build` を使う**

### 破壊的変更では配布ページを分ける

UserScript は他人のブラウザで動く。**同一パスの中身を差し替えてよいのはバグ修正だけ。**
Worker の API も `/v1/` を固定し、破壊的変更では `/v2/` へ上げる。
配布は公開プロジェクト [`/cosense-grass`](https://scrapbox.io/cosense-grass/) で、ページは `dev` (開発版) と `v1`、`v2`… (リリース版)。
**バンドルを貼るのは持ち主の手作業**で、こちらからは Cosense に書き込まない (ADR-0005 の改訂、ADR-0013 決定 3)。

## 開発フロー

`CONTRIBUTING.md` は置かない。外部からの報告は Issue で受ける (テンプレートは `.github/` にある)。

- main から `<type>/<短い説明>` を切り、小さく作って PR
- PR タイトルは Conventional Commits。squash merge でそのままコミット要約になる
- `Closes #N` は **PR 本文**に書く。コミットメッセージ側は squash で捨てられる
- 見た目が変わる変更は証跡を Gyazo へ上げて URL を貼る。**画像をリポジトリにコミットしない**
