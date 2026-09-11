# 設計

Cosense (旧 Scrapbox) の活動を GitHub のコントリビューショングラフのように可視化する。
成果物は UserScript と Cloudflare Worker + D1 の2つ。

前提となる実測事実は `research.md`、指示書からの逸脱とその理由は `decisions.md` にある。
**この文書を読む前に `decisions.md` の ADR-0001 と ADR-0002 を読むこと。** 送信経路と指標の持ち方が
素朴な設計と違う理由がそこにある。

---

## 1. ゴールと非ゴール

### ゴール

- Cosense ユーザーが `code:script.js` に1行書くだけで導入できる
- 「書いた」だけでなく「読んだ」活動も記録する
- 活動量を濃さ、読み書きのバランスを色相で表す2次元の草
- 共有可能な静的 SVG URL を発行する
- 個人情報を持たない。アカウント登録も認証フローもなし

### 非ゴール

- プロジェクト内のランキングや競争機能。読みの活動量は検証手段がゼロで、
  マウスを揺らすスクリプトで無限に稼げる
- ページ内容の記録・分析
- リアルタイム性。数分の遅延は許容する

---

## 2. アーキテクチャ

```
[scrapbox.io のページ内 / UserScript]
  センサー  20 秒ごとに localStorage のビットマップへ bit を立てる
  送信      3 分ごと + visibilitychange(hidden) に new Image().src で GET
  表示      localStorage の日次集計から DOM に SVG を描く (ツールチップあり)
  設定      鍵の表示と貼り付け、共有 URL のコピー、read 計上の on/off
                    │
                    ▼ GET /v1/p.gif?...
         [Cloudflare Worker] ─── [D1]
                    │
                    ▼ GET /v1/g/{publicId}.svg
         Cosense の任意ページに [URL] で貼れる
```

送信が GET なのは CSP の制約 (ADR-0001)。受信方向は使えないので DOM 注入の草はローカルのデータから
描く (ADR-0003)。

### リポジトリ構成

```
wrangler.jsonc              Worker + D1 + Cron
vitest.config.ts            @cloudflare/vitest-plugin
migrations/0001_init.sql
src/shared/                 Worker と UserScript の両方から import する
  bits.ts                   ビットマップ: base64url 往復 / OR / popcount
  scale.ts                  四分位スケール
  balance.ts                色相バランス
  oklch.ts                  OKLCH → sRGB。彩度を二分探索でガモットに詰める
  color.ts                  セルの色
  graph.ts                  53 週グリッドのレイアウト計算
src/worker/
  index.ts                  ルーティング
  ingest.ts                 GET /v1/p.gif
  svg.ts                    GET /v1/g/{publicId}.svg
  json.ts                   GET /v1/g/{publicId}.json
  admin.ts                  DELETE /v1/me
  cron.ts                   古いビットマップの削除
src/userscript/
  index.ts                  エントリ。常駐とマウント
  sensor.ts                 20 秒ポーリングと lines:changed
  beacon.ts                 画像 GET 送信
  store.ts                  localStorage
  render.ts                 DOM 注入の草とツールチップ
  settings.ts               設定 UI
  backfill.ts               /api/commits からの遡り
tools/publish-userscript.ts バンドルを Cosense の配布ページへ反映
```

`shared/` を両方から import するので、Worker が出す SVG と DOM 注入の草で配色が食い違わない。
UserScript は esbuild で単一ファイルにバンドルする。

---

## 3. 識別と認証

アカウント登録なし。認証フローなし。クライアントが自分で鍵を生成する。

```
secret    localStorage に置く秘密        書き込み権
uid       SHA-256(secret)               サーバ主キー。外部に出さない
publicId  SHA-256(uid) の先頭 32 桁      共有 URL。書き込み権を導出できない
```

一方向ハッシュなので `publicId` から `uid` / `secret` は復元できない。
`publicId` はクライアント側でも計算できるので、共有 URL の表示にサーバ問い合わせは不要。

OAuth やサーバ発行トークンは検討して不採用。サードパーティ Cookie は Safari ITP 等でブロックされるため
どのみち localStorage にベアラトークンが必要になり、OAuth が唯一解決する「localStorage 消失時の復旧」は
鍵を画面に表示するだけで解決する。個人情報を持たないのでプライバシーポリシーの負担を負う理由もない。

### 必ず守ること

- **`secret` を平文で D1 に保存しない。** 必ずハッシュして `uid` にする。D1 が漏洩しても
  誰の草にも書き込めない状態を保つ
- **`publicId` を `uid` から独立に見せる。** 共有 URL から書き込み権が推測できてはならない
- **リクエストに `uid` を入れない。** 必ずサーバ側で `secret` から導出する
- **UserScript にシークレットを埋め込まない。** UserScript はユーザーページに書かれ、
  公開プロジェクトなら全インターネットから読める。配布するコードは完全に公開前提で書く

### 復旧と複数デバイス

設定 UI に現在の `secret` を表示し、別の端末で同じ草に記録するには貼り付けるよう案内する。
保管はパスワードマネージャを推奨し、**Cosense のページに書かないよう明記する**
(共有プロジェクトでは他メンバーに書き込み権を渡すことになる)。

複数デバイスからの送信はビットマップの OR でマージされるので、同じ鍵を貼るだけで統合される。

---

## 4. 指標の定義

### 原子単位は「分」

コミット数は使わない。Cosense のコミットは改行やキーストロークに近い粒度で、打鍵スタイルによって
数倍変動する。**その日にアクティブだった分のユニーク個数**を指標にする。実作業時間に近く、
入力スタイルに対して不変。

1 日を 1440 bit のビットマップで表す (ADR-0002)。write 用と read 用の 2 枚。
集合演算なので冪等かつマージ可能で、順序依存がない。

### read / write

| | 意味 |
|---|---|
| write | 自分の編集があった分 |
| read | 閲覧のみの分。スクロール・カーソル移動を含む |

同一の分に両方あれば write を優先する。サーバ側で `r_effective = r & ~w` として実現する。
これにより write と read は構造的に排他になり、`total = w + r` が二重計上なしで成立する。

### 付随指標 (ツールチップ用)

- `pages` その日に編集したユニークページ数
- `created` その日に新規作成したページ数。プレースホルダー (未作成のリンク先) は含めない

---

## 5. D1 スキーマ

```sql
CREATE TABLE users (
  uid       TEXT PRIMARY KEY,            -- SHA-256(secret)
  public_id TEXT UNIQUE NOT NULL,        -- SHA-256(uid)[0:32]
  tz        TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  ver       INTEGER NOT NULL DEFAULT 0,  -- ETag 兼用
  created   INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
) WITHOUT ROWID;

-- 集計値。永続
CREATE TABLE daily (
  uid TEXT, project TEXT, day TEXT,
  w INTEGER NOT NULL DEFAULT 0,
  r INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  backfilled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, project, day)
) WITHOUT ROWID;

-- 冪等マージ用のビットマップ。Cron で 90 日より古いものを削除
CREATE TABLE daybits (
  uid TEXT, project TEXT, day TEXT,
  wbits BLOB NOT NULL,   -- 180 バイト
  rbits BLOB NOT NULL,
  PRIMARY KEY (uid, project, day)
);
```

### なぜビットマップを別テーブルにするか

`WITHOUT ROWID` が効くのは行が小さいときだけ (目安はページサイズの 1/20)。
ビットマップを同じ行に置くと 360 バイトを超えて利点が消える。分けておけば古いビットマップだけ捨てられる。

### `daily` の w / r は max で更新する

`daybits` が Cron で消えた後に古い日のビーコンが届くと、ビットマップが新規作成されて
集計値が小さくなりうる。`max(daily.w, excluded.w)` で更新すれば減らない。

### SQLite の注意

- `INSERT ... SELECT ... ON CONFLICT` には **`WHERE true` が必須** (パース曖昧性)
- `max(x, excluded.x)` はテーブル名で修飾する。1 引数の `max(x)` は集約関数でエラーになる
- conflict target は明示する
- 1 クエリのバインドパラメータは 100 個まで。Free プランは 1 invocation 50 クエリまで

---

## 6. Worker API

ベース URL は環境変数で設定可能にする。

### `GET /v1/p.gif` — 記録

```
?v=1&s=<secret>&tz=<tz>&d=<project>|<day>|<wbits>|<rbits>|<pages>|<created>;...
```

1. `uid = SHA-256(secret)`、`publicId = SHA-256(uid)[0:32]`
2. `users` に UPSERT して `last_seen` を更新
3. 対象の `(project, day)` の `daybits` を 1 クエリでまとめて SELECT
4. Worker 内で OR してから popcount。`r_effective = r & ~w`
5. `daybits` を UPSERT、`daily` を UPSERT (w / r / pages / created は max)
6. `ver` を +1
7. **200 と 43 バイトの透過 GIF** を返す。クライアントが `onload` で到達を判定できる

バリデーション。

- `day` が未来なら拒否する。システム時計を進めるだけで未来の草が生えてしまう
- 30 日より古い `day` は ingest では拒否する。バックフィルは別経路で緩める
- ビットマップ長が 180 バイトでなければ拒否する
- 1 リクエストの `(project, day)` 件数に上限を置く (14 程度)。D1 のバインドパラメータ 100 と
  Free の 50 クエリに収める

### `GET /v1/g/{publicId}.svg` — 共有グラフ

| クエリ | 既定 | 意味 |
|---|---|---|
| `theme` | `light` | `light` / `dark` |
| `weeks` | `53` | 表示週数 |
| `mode` | `bi` | `bi` = 2 次元 / `write` = 単色 (色相を 155° 固定) |
| `project` | 全部 | 指定時はそのプロジェクトのみ |

- ETag は `users.ver` と描画パラメータから作る。**日付は入れない。**
  四分位は全期間の分布で決まるので、1 日更新されると全マスの色が変わり得る
- `Cache-Control: public, max-age=300`。Cosense 側にキャッシュはないので鮮度はここで決まる
- `Content-Type: image/svg+xml; charset=utf-8` を必ず付ける。これがないと Cosense で表示されない

### `GET /v1/g/{publicId}.json`

当面 UserScript からは使わない (ADR-0003)。`{ days: [{day, w, r, pages, created}], scale: {...} }`。

### `DELETE /v1/me`

ボディに `secret`。該当 `uid` の全レコードを削除する。最初から実装する。

### Cron

- 90 日より古い `daybits` を削除する (`daily` に集計済みなので情報は失われない)
- 30 日以上送信のない `uid` をログ出力する

---

## 7. 配色

### 3 チャンネルの役割

| | 意味 | 算出 |
|---|---|---|
| L 明度 | その日の活動量 | 合計分数の四分位 → 5 段階 |
| H 色相 | 読み書きのバランス | `155 - 80 * balance` (青 235° ↔ 緑 155° ↔ 黄 75°) |
| C 彩度 | 比率の確からしさ | 合計分数が少ないほど低く (灰色寄り) |

**色相が青から黄である理由。** 変更するなら 3 条件すべてを満たすこと。

1. 弧が短い。端から端まで 160°。大きく超えると中点が混色に見えなくなる
2. 端点が青と黄の軸。P 型・D 型色覚で保たれるのはこの軸。赤と青、赤と緑は差が潰れる
3. 弧の全域で彩度が確保できる。明度固定なので、彩度の取れない色相が混じるとそこだけ濁る

副次的に、中点が緑になるので「バランスの良い日は GitHub と同じ緑」「単色モードは色相を 155° に
固定するだけ」という利点がある。

### 明度・彩度ランプ

| Level | Light L | Dark L | Cmax |
|---|---|---|---|
| 0 | `#ebedf0` | `#262624` | — |
| 1 | 0.88 | 0.32 | 0.05 |
| 2 | 0.76 | 0.45 | 0.09 |
| 3 | 0.63 | 0.58 | 0.12 |
| 4 | 0.50 | 0.72 | 0.145 |

### 四分位スケール

GitHub と同じ方式。0 の日を母集団から除外し、`Q3 + 1.5 × IQR` で外れ値を落としてから四分位を取る。

**比較演算子は `<=` にする。** 離散値が少ないと四分位が同値に潰れ、`<` だと全マスがいきなり
Level 4 になる。テストでここを固定する。

**母集団は `backfilled = 0` の日に限定する。** バックフィル日は read が 0 なので、混ぜると
導入後の日だけ活動量が底上げされ、導入前が不当に薄くなる。

### バランス (色相)

読みと書きの比は典型的に 6 対 1 程度。素朴な `w / (w + r)` では全マスが青一色になる。
四分位と同じく中心を自分の中央値に置く。

```js
const odds = d => Math.log((d.w + 3) / (d.r + 3));
const center = median(days.filter(d => d.w + d.r >= 3 && !d.backfilled).map(odds));
const balance = d => Math.tanh((odds(d) - center) / 1.2);   // -1 (読) .. +1 (書)
```

**`center` の母集団から `backfilled` を除く。** バックフィル日は `r = 0` なので、混ぜると
中心が書き側に大きくずれる。

### OKLCH から sRGB

明度を固定したまま色相を回すと、sRGB のガモット外に出る組み合わせが必ず発生する (特に高明度と青)。
**彩度を二分探索で詰める。**

変換は CSS Color 4 の固定行列と立方根だけなので依存ゼロで書ける。係数はリファレンス実装と
突き合わせてテストで固定する。

**`oklch()` の CSS 記法は使わない。** `<img>` 経由の SVG ではブラウザ依存が読めないので、
Worker 側で 16 進数に焼き込む。

---

## 8. SVG 出力

- 列が週 (日曜始まり)、行が曜日の 7 行、直近 53 週分。左端と右端の列は欠ける
- セル 11×11px、gap 3px、`rx="2"` 程度
- 月ラベルを上部に、曜日ラベル (月・水・金) を左に
- **`width` / `height` / `viewBox` の 3 つを必ず出力する。** Cosense で表示するのに必要
- **`<img>` 内の SVG は完全に非インタラクティブ。** `<title>` のツールチップも出ず、外部フォントも
  外部 CSS も読めない。すべてインラインで自己完結させる
- **凡例は必須。** 5 列 × 4 行の 2 次元凡例を右下に配置する。2 次元エンコーディングは
  凡例なしでは意味を復元できない
- ダークモードは `?theme=dark` で出し分ける。`prefers-color-scheme` は使えない
- バックフィル日との境界に「ここから計測開始」の線を引く

---

## 9. UserScript

### 導入

ユーザーページ (`/{project}/{username}`) に1行。

```
code:script.js
 import "/api/code/<配布project>/<page>/script.js"
```

外部ドメインからの import は成立しない (ADR-0005)。バンドルは Cosense の公開プロジェクトに置く。

### センサー

20 秒ごとに判定し、条件を満たせば現在の分の read bit を立てる。

- `document.visibilityState === "visible"`
- **`document.hasFocus()`。これは必須。** これがないと開きっぱなしのタブを全部数えて、
  ただのブラウザ起動時間計測になる
- 直近 3 分以内に操作があった (`scroll` / `wheel` / `mousemove` / `pointerdown` / `keydown` / `touchmove`)

write は `scrapbox.on("lines:changed", ({by}) => ...)` の `by === "edit"` のときだけ立てる (ADR-0006)。
`remote` は他ユーザー、`userscript` は自前、`navigation` はページ遷移。

新規ページ作成の検出では**プレースホルダーページをカウントしない**。

### localStorage

| キー | 内容 |
|---|---|
| `secret` | 鍵 |
| `bits` | `{"<project>:<YYYY-MM-DD>": {w, r}}` ビットマップを base64url で。当日と未送信分 |
| `daily` | `{"<project>:<YYYY-MM-DD>": {w, r, pages, created}}` 表示用。53 週分 |
| `settings` | read 計上の on/off など |

複数タブでキューが共有される (Cosense は複数タブで開かれがち)。

### 送信

| トリガ | 動作 |
|---|---|
| 3 分ごと | 当日分と未送信の前日分を画像 GET で送る |
| `visibilitychange` (hidden) | 同じものを即送る。失敗しても次回復元されるので後処理は不要 |
| ロード時 | 未送信分を送る |

- `img.referrerPolicy = "no-referrer"` を `src` より前に設定する
- URL が 8KB を超えるなら日を分割して複数回送る
- 複数タブの重複は localStorage のロックで 10 秒抑制する程度でよい。OR なので重複送信は無害

### 表示

ページメニューに「草を見る」と「草の設定」を追加する。

草は localStorage の日次集計から描き、ツールチップを出す。

```
2026-09-12 — 書き 12 分 / 読み 38 分 / 7 ページ閲覧 / 2 ページ新規作成
```

2 次元表示では色の絶対的な意味が読めないので、DOM 注入版では必ず出す。
テーマは `document.documentElement` から判定する。

`page:changed` / `layout:changed` で再マウントと後片付けをする。

### バックフィル

初回導入時のみブラウザ内で実行する。

1. `/api/pages/:project?limit=1000&skip=N` でページ一覧を取得 (limit は 1000 で黙ってクランプされる)
2. 各ページの `/api/commits/:project/:pageId` を取得。**メンバーでないと 403**
3. 自分の `userId` の commit のみ抽出する。`created` は**秒**なので 1000 倍する
4. **`changes` が `LinksChange` / `IconsChange` / `TitleChange` だけの commit を除外する。**
   リネーム時の一括リンク更新を活動として数えないため (ADR-0004)
5. 秒を分に落としてビットマップに変換し、通常のビーコンと同じ経路で送る。
   read は 0 なので `backfilled` が立つ
6. 並列度 5、インターバル 200ms。進捗を表示し、中断と再開ができるようにする

commits は約 30 日で消えるので、それ以前は遡れない。UI に明示する。

`connect.sid` を外部に送らない。この方式なら非公開プロジェクトでも安全。

---

## 10. セキュリティとプライバシー

### 受容する脆弱性

実害が自分のグラフに限定されるので、過剰な対策は実装しない。

- `secret` が漏れると他人が自分の草に書き込める。被害は自分のグラフの汚染だけで、他者に波及しない
- `publicId` を知る人に日別活動量が見える。共有するかはユーザーの選択

`secret` は URL クエリに乗る (ADR-0001)。Cloudflare のアクセスログは Logpush を設定しない限り
保存されないが、README に明記する。

### 対策すること

- 新規 uid の大量生成による DB 膨張。1 uid 1 日あたりの行数は主キーで有界。
  加えて時計チェックと件数上限で 1 リクエストの投入量も有界にする。
  IP あたりの新規 uid 作成を Cloudflare 側で軽く絞る
- 未来の分。システム時計を進めるだけで未来の草が生えるので拒否する

### プライバシー

- **read イベントにページ識別子を一切載せない。** 「誰がいつ何を読んだか」は Cosense 上のどこにも
  公開されていない情報で、共同プロジェクトでは監視感が強い。ビットマップは分の情報しか持たない
- 共有 SVG には合算スコアのみ。読みと書きの内訳は DOM 注入版 (本人のみ) に出す
- **読みの活動量は検証手段がゼロ。** プロジェクト内ランキング等の競争的な用途には使わない

---

## 11. 実装順序

段階ごとに動作確認してから次へ進む。1 PR = 1 関心事。

1. **基盤と SVG 生成・配色** — ダミーデータで `/v1/g/demo.svg`。Cosense に貼って実表示を確認する。
   最も不確実な部分を最小コストで潰す
2. **D1 と `GET /v1/p.gif`** — curl で冪等性を確認する (同じビーコンを 2 回送って値が変わらないこと)
3. **UserScript のセンサーとビットマップ** — 送信せず console で挙動確認。
   特に `by === "edit"` で他人の編集を弾けているか
4. **接続** — 実データで 1 週間動かす
5. **パラメータ確定** — §13 を実測値で決める
6. **バックフィル**
7. **DOM 注入とツールチップ、設定 UI**

## 12. テスト

- `shared/bits.ts` base64url 往復、OR の冪等性、popcount
- `shared/scale.ts` 四分位。**比較が `<=` であること**と、離散値が少ないと四分位が同値に潰れるケース
- `shared/oklch.ts` リファレンス値との突き合わせ。ガモット外 (高明度と青) で二分探索が効くこと
- `shared/balance.ts` `backfilled` を center の母集団から除くと中心がずれないこと
- `worker/ingest.ts` 同じビーコンを 2 回送って値が変わらない。未来と 30 日超の過去を拒否する。
  `r & ~w` の排他。`daybits` がない日に古いビーコンが来ても `daily.w` が減らない
- `worker/svg.ts` スナップショットで構造の回帰を見る。`viewBox` と凡例があること

バグ修正は失敗する再現テストを先に書く。新しいテストは検証対象の振る舞いを一時的に壊して
赤くなるのを見てから仕上げる。

テスト環境は `@cloudflare/vitest-plugin` (旧 `vitest-pool-workers`)。
マイグレーションは `readD1Migrations` と `applyD1Migrations` で適用する。

## 13. 未決パラメータ

すべて 1 週間分の実データを見てから決める。それまでは仮値で実装してよい。

| パラメータ | 仮値 | 決め方 |
|---|---|---|
| `tanh` の除数 | 1.2 | 色相の効き。小さいと振り切れ、大きいと緑に集まる |
| 彩度の飽和点 | 15 分 | この分数で彩度が最大になる |
| 離席判定 | 3 分 | 無操作でこれを超えたら数えない |
| デッドゾーン | 3 分 | 1 日の合計がこれ未満なら Level 0 扱い |
| 外れ値除去 | Q3 + 1.5 × IQR | 強すぎると繁忙期が潰れる |
| 送信間隔 | 3 分 | リクエスト数とのトレードオフ |

1 週間ログを取れば、`center` の実測値・読み書き比・分布の形が同時に分かる。

## 14. 既知のトレードオフ

いずれも意図的な選択。

- **過去のマスの色が後から変わる。** 四分位は全期間の分布で決まるので、今日大量に書くと
  去年のマスが薄くなる。GitHub も同じ挙動。固定閾値にすれば避けられるが、ユーザー間の適応性を失う
- **L と C が両方とも活動量に連動する。** 少ない日は淡くて灰色、多い日は濃くて鮮やか。
  方向が揃っているので破綻はしない。ただし L は相対順位で C は絶対分数なので、活動量の多い
  ユーザーでは「下位 25% なのに 40 分」すなわち淡いが鮮やか、という組み合わせが出る。
  実データを見て不自然なら C もレベル依存に寄せて単純化してよい
- **2 次元にしたぶん一覧性は落ちる。** GitHub の草の強さは濃淡だけ一目で読めること。
  `?mode=write` の単色モードを必ず用意する
- **読みの活動は導入日より前が一切存在しない。** 原理的に取得不能
- **20 秒間隔のポーリングは分境界で過大に数えうる。** 実作業 20 秒でも 2 分計上されることがある。
  許容する
