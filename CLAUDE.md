# CLAUDE.md

Cosense (旧 Scrapbox) の活動を草として可視化する。成果物は **UserScript** (センサー兼ビューア) と
**Cloudflare Worker + D1** (記録と SVG 配信) の 2 つ。Worker は作者が 1 つホストして公開提供する。

**現在は設計段階で、実装が 1 行もない。** `docs/` が唯一の正本。

## docs の読み方

| | 役割 |
|---|---|
| `docs/decisions.md` | ADR。**最初に読む。** 送信経路と身元の紐づけが素朴な設計と違う理由がここにある |
| `docs/design.md` | 設計。指標・スキーマ・API・配色・脅威モデル |
| `docs/research.md` | 実測事実。**基準日と出典が付いている。推測で上書きしない** |
| `docs/roadmap.md` | 実装順と段階ごとの完了条件。次の作業は段階 0 |
| `docs/privacy.md` | プライバシーポリシーの草案 |

設計判断を変えるときは ADR を足すか、既存 ADR に改訂を書く。**ADR が 20 件を超えたら
`docs/decisions/` へ分割する** (現在 14 件。それまでは単一ファイルのまま)。

## 検証

```sh
npm run check                # push 前のゲート。lint → typecheck → knip → test → build
npm run lint:fix             # biome の自動修正 (import の並びもここで直る)
npm run dev                  # wrangler dev。/__scheduled で Cron を叩ける
./scripts/check-links.sh     # Markdown の相対リンクが実在するか
```

**CI も `npm run check` を呼ぶ**ので、ローカルと CI が乖離しない。
**Cloudflare の認証情報なしで green になることが不変条件。** Workers のテストは
ローカルの workerd だけで走る。

**`check-links.sh` は外部 URL を見ない。意図的。** docs は Cosense と Cloudflare の一次情報への
出典を大量に持つので、到達性を CI で見ると先方の都合で赤くなる。出典の鮮度は `research.md` の
基準日付きの記述で人間が管理する。

### テスト中に出る警告は設計どおり

`wrangler.jsonc` に `secrets.required` を宣言しているので、値が無いと
「Missing required secrets」が出る。**CI に秘密を置かないので消えない。失敗ではない。**
ローカルで消したいときは `.dev.vars.example` を `.dev.vars` にコピーする。

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
- **`migrations/` は空に保つ** (段階 3 まで)。`applyD1Migrations` は文を含まない `.sql` を
  拒否するので、中身の無いプレースホルダは置けない
- **knip の `ignoreDependencies: ["cloudflare"]` は消さない。** `cloudflare:test` という
  仮想モジュールを `cloudflare` という実パッケージだと誤認するため
- **biome は `worker-configuration.d.ts` を見ない** (生成物で 15,000 行あるため)

### 破壊的変更では配布ページを分ける

UserScript は他人のブラウザで動く。**同一パスの中身を差し替えてよいのはバグ修正だけ。**
Worker の API も `/v1/` を固定し、破壊的変更では `/v2/` へ上げる。

## 開発フロー

`CONTRIBUTING.md` は置かない。外部からの報告は Issue で受ける (テンプレートは `.github/` にある)。

- main から `<type>/<短い説明>` を切り、小さく作って PR
- PR タイトルは Conventional Commits。squash merge でそのままコミット要約になる
- `Closes #N` は **PR 本文**に書く。コミットメッセージ側は squash で捨てられる
- 見た目が変わる変更は証跡を Gyazo へ上げて URL を貼る。**画像をリポジトリにコミットしない**
