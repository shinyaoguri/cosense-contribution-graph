# ADR-0022 公開ページは英語を既定にし、日本語を `/ja` の下に分ける

**2026-09-26、Issue #141。ADR-0018 の `/` と `/privacy` の言語を決め直す。**

## 文脈

- Google の OAuth 同意画面には、ホームページ `https://grass.soui.dev/` とプライバシーポリシー
  `https://grass.soui.dev/privacy` を登録してある (roadmap 段階 4)。brand verification はこの 2 つを読む
- どちらも日本語のページで、英語は冒頭の `About cosense-grass` とポリシー末尾の `Summary in English` だけだった。
  brand verification は 2 回差し戻され、指摘はアプリの目的・ポリシーの内容・アプリ名の一致 (research §6)。
  自動判定がページの主な言語を読めていない可能性を消しておきたい
- **登録済みの URL を変えると再審査になる** (roadmap 段階 4)

## 決定

1. **`/` と `/privacy` を英語だけのページにする。** 日本語は `/ja` と `/ja/privacy` に分ける。
   登録済みの URL を変えないので、同意画面の設定は触らない
2. **ページの上端に言語の切り替えを置く。** スクリプトを載せない (CSP `script-src 'none'`) ので、
   ボタンではなく**対のページへのリンク**にする。`<html lang>` と `<link rel="alternate" hreflang>` も出す
3. **Accept-Language で振り分けない。** 同じ URL の中身が要求ごとに変わると、`public` なキャッシュに
   `Vary` が要り、審査の自動判定が何語を見るかも読めなくなる
4. **ポリシーの正本は 2 ファイルにする。** `docs/privacy.md` (日本語) と `docs/privacy.en.md` (英語) で、
   **要約ではなく全訳どうし。** 節・表の行・箇条書きの数が一致することをテスト (`test/worker/site.test.ts`) が見る。
   ADR-0018 の「2 か所に同じ文面を置かない」は、言語ごとに 1 か所と読み替える
5. **Cosense の中の UserScript からは日本語版 (`/ja/privacy`) を開く。** ダイアログが日本語なので

## 帰結

- ポリシーを変えるときは 2 ファイルを同じ PR で直す。片方だけ節や項目を増やすとテストが落ちる
  (文の中身の食い違いまでは見ない。訳の正しさはレビューで見る)
- `/account` と `/auth/callback` は日本語のまま。サインインした後の画面で審査は読まず、
  フォームや削除の確認語まで絡むので別に扱う
- 英語のトップにも「設定」だけは日本語で残る。UserScript の UI の名前で、利用者が画面で探す文字列だから
