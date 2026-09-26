# 設計判断の記録

出発点は会話で与えられた実装指示書。実装前の検証 (`research.md`) で前提が崩れた箇所を差し替えた。
**指示書からの逸脱はここに理由を書く。** 根拠が消えると後から「なぜこんな形なのか」が読めなくなる。

新しい ADR は `NNNN-<slug>.md` として足し、下の一覧に 1 行足す (載せ忘れは `scripts/check-links.sh` が落とす)。
既存の判断を変えるときは、その ADR に日付つきの改訂を書き足す。

## 一覧

| ADR | 判断 | 日付 |
|---|---|---|
| [ADR-0001](0001-image-beacon.md) | 送信経路を画像 GET ビーコンにする | 2026-09-12 |
| [ADR-0002](0002-daily-bitmap-full-sync.md) | 分バケットを日次ビットマップで全量送信する | 2026-09-12 |
| [ADR-0003](0003-no-inbound-channel.md) | 受信方向は当面作らない | 2026-09-12 |
| [ADR-0004](0004-backfill-30-days.md) | バックフィルは直近 30 日に限る | 2026-09-12 (ADR-0012 で置き換え) |
| [ADR-0005](0005-distribution-via-cosense-project.md) | 配布は Cosense の公開プロジェクト経由にする | 2026-09-12 |
| [ADR-0006](0006-exclude-others-by-event-by.md) | 他人の編集の除外はイベントの `by` で判定する | 2026-09-12 |
| [ADR-0007](0007-multi-project.md) | マルチプロジェクトの扱い | 2026-09-12 |
| [ADR-0008](0008-single-hosted-worker.md) | 作者が 1 つホストして公開提供する | 2026-09-12 |
| [ADR-0009](0009-per-device-asymmetric-keys.md) | 書き込み権はデバイスごとの非対称鍵で証明する | 2026-09-12 |
| [ADR-0010](0010-no-periodic-sending.md) | 定期送信を廃止して D1 Free の予算内に収める | 2026-09-12 |
| [ADR-0011](0011-google-sign-in.md) | Google サインインで身元を紐づける | 2026-09-12 |
| [ADR-0012](0012-no-backfill.md) | バックフィルを実装しない | 2026-09-12 |
| [ADR-0013](0013-cheap-operations.md) | 運用は安い範囲に絞る | 2026-09-12 |
| [ADR-0014](0014-deploy-from-github-actions-only.md) | デプロイは GitHub Actions からだけ行う | 2026-09-12 |
| [ADR-0015](0015-stage1-deviations.md) | 段階 1 で docs の記述から外れた判断 | 2026-09-13 |
| [ADR-0016](0016-color-schemes.md) | 配色をスキームで差し替え、既定を手で選んだ青 → ピンクにする | 2026-09-13 |
| [ADR-0017](0017-device-list-on-account-page.md) | 端末の一覧は Worker のサインイン済みページで見せる | 2026-09-15 |
| [ADR-0018](0018-management-on-worker-pages.md) | 管理は cosense-grass のページに集約し、Cosense 側はそのブラウザでしかできないことだけにする | 2026-09-15 |
| [ADR-0019](0019-worker-only-rendering.md) | 草を描くのは Worker だけにし、UserScript は数えて送るだけにする | 2026-09-15 |
| [ADR-0020](0020-daily-json.md) | 日ごとの集計値を、草とは別の推測しにくい URL の JSON で出す | 2026-09-24 |
| [ADR-0021](0021-activity-overview.md) | 活動の内訳を 4 軸 (作る / 育てる / 関わる / 読む) で数え、草とは別の SVG で見せる | 2026-09-26 |
| [ADR-0022](0022-english-default-pages.md) | 公開ページは英語を既定にし、日本語を `/ja` の下に分ける | 2026-09-26 |
