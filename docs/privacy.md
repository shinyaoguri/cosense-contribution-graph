# cosense-grass プライバシーポリシー

## このサービスについて

cosense-grass は、Cosense (旧 Scrapbox) での活動量を可視化するツールです。
**Cosense の公式サービスではありません。** 運営元の株式会社 Helpfeel とは関係のない、個人のプロジェクトです。
ソースコードと設計は [GitHub](https://github.com/shinyaoguri/cosense-contribution-graph) で公開しています。

## 保存するもの

| 項目 | 形 | 目的 |
|---|---|---|
| 利用者の識別子 | Google アカウントの `sub` をサーバ固有の秘密で HMAC した値 | 誰の記録かを区別する |
| デバイスの公開鍵 | 公開鍵そのもの | 記録の送信元が本人か検証する |
| デバイス登録用の使い捨ての符号 | 符号そのものではなく、そのハッシュ | サインインしたデバイスの鍵を登録する |
| プロジェクトの識別子 | 上記の識別子でソルトしたハッシュ | プロジェクトごとに集計する |
| 日ごとの活動量 | 分単位のビットマップと、1 日あたりの集計値 (書いた分数と読んだ分数、書いた分のうち新しく作ったページと他の人が作ったページに書いた分数、編集したページ数、新しく作ったページ数、作ったリンクの件数) | 草と活動の概観を描く |
| タイムゾーン | `Asia/Tokyo` などの文字列 | 日の境界を決める |

## 保存しないもの

- **メールアドレス、氏名、プロフィール画像。** Google から受け取る情報は `sub` (アカウントの
  識別子) だけで、それも保存せず、サーバ固有の秘密で HMAC した結果だけを持ちます
- **プロジェクト名。** ハッシュしか送られないので、サーバは名前を知りません
- **Cosense のユーザー名。** 共有 URL で画像を描くときに受け取りますが、保存しません (下の「共有される範囲」)
- **ページのタイトルや内容。** 何を書いたか、何を読んだかは送られません
- **どのページを読んだか。** 閲覧の記録には「何分に活動していたか」しか含まれず、
  ページの識別子は一切含まれません
- **書いたページの作成者、リンク先。** 書いたページが自分で新しく作ったものか、他の人が作ったものかはブラウザの中で判定し、
  送られるのは分数とリンクの件数だけです
- **秘密鍵。** 各デバイスのブラウザ内に留まり、送信されません

## Google ユーザーデータの取り扱い

Google でのサインインは、**複数の端末 (PC やブラウザ) の記録を、同じ 1 人の利用者の草にまとめるため**に使います。
サインインは最初の 1 回と、端末を追加するときだけ必要です。以降の記録の送信は各端末の鍵による署名で認証します。

- **取得するもの:** `openid` スコープのみを要求し、受け取るのはアカウントの識別子 (`sub`) だけです。
  メールアドレス、氏名、プロフィール画像は取得しません
- **使い方:** `sub` からサーバ固有の秘密で HMAC した利用者の識別子を作り、同じ Google アカウントの端末を 1 人の記録にまとめます。
  それ以外の目的 (広告、プロファイリング、機械学習など) には使いません
- **共有:** 第三者に渡しません。販売もしません
- **保護:** 通信はすべて HTTPS です。`sub` そのものと Google の ID トークンは保存せず、本人確認に使ったらすぐに捨てます。
  保存するのは元に戻せない HMAC の結果だけです。サインインの後に画面に表示するコードは 5 分で使えなくなり、1 回しか使えません
- **保持と削除:** 利用者の識別子は、下の「データの削除」で削除するまで保持します。削除すると、識別子に結びついた記録と
  端末の鍵がすべて消えます

Google API から受け取った情報の利用は、Limited Use の要件を含む
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy) に従います。

## Cookie

認証の途中で、なりすましを防ぐための短命な Cookie を 1 つ使います (`__Host-grass-auth`、有効期間 10 分)。
中身は乱数と発行時刻だけで、利用者の識別子は含みません。サインインから戻った時点で、成功しても失敗しても削除します。

サインインに成功したときは、**登録した端末の一覧を見るための Cookie を 30 分だけ**発行します
(`__Host-grass-session`)。中身は利用者の識別子と発行時刻で、署名しています。
JavaScript からは読めず (HttpOnly)、ほかのサイトからの遷移では送られません (SameSite=Lax)。
端末の一覧と失効の画面でだけ使い、活動の記録には使いません。
追跡目的の Cookie は使いません。

## ログ

サーバのログには集計値だけを記録します。**利用者の識別子はログに出しません。**
記録するのは、書き込み量の概算、認証の失敗率、エラー率などの統計です。

## 保持期間

| データ | 保持 |
|---|---|
| 分単位のビットマップ | 90 日 |
| 日ごとの集計値 | **削除しません** |
| デバイスの公開鍵 | 失効させるか、データを削除するまで |
| デバイス登録用の符号のハッシュ | 使うまで (最長 5 分。使われなければその後の定期処理で削除) |

日ごとの集計値は、**数年後に振り返れるように無期限で保持します。**
不要になったら設定画面からいつでも削除できます。

分単位のビットマップは、同じ記録が重複して届いたときに正しくまとめるための作業データです。
90 日で削除しますが、日ごとの集計値が残るのでグラフは変わりません。

## 共有される範囲

活動量のグラフは、**利用者が共有 URL を誰かに渡したときだけ**他人が見られます。
共有 URL は利用者の識別子から一方向に導出され、第三者が推測や計算で求めることはできません。

草の共有 URL には日ごとの合計量 (と、書いたのと読んだのどちらが多いかの色) だけが表れます。
**草の URL からは、同じ期間の活動の概観 (新しく作る・育てる・他の人のページに関わる・読むの割合) の画像も開けます。**
表れるのは期間全体の割合だけで、日ごとの値は表れません。

**日ごとの数値の URL (JSON) は、草の URL とは別にあります。** 管理のページに合算の分を表示します。
この URL を渡した相手には、**日ごとの書いた分数・読んだ分数・編集したページ数・新しく作ったページ数、
新しく作ったページと他の人が作ったページに書いた分数、作ったリンクの件数**が見えます。草の URL からこの URL を作ることはできないので、草を見せた相手に数値まで見せるかは別に選べます。
この URL も、利用者の識別子から一方向に導出され、第三者が推測や計算で求めることはできません。
検索エンジンには載せないよう指示しています。

**プロジェクト別の共有 URL には、プロジェクト名が含まれます。** どの草がどのプロジェクトのものか
分かるようにするため、画像にも名前を描きます。サーバはこの名前を保存せず、画像を描くときに
受け取って使うだけです。**名前を見せたくないときは、URL の末尾の `?l=...` を削って渡してください**
(名前のない草が表示されます)。全プロジェクトを合算した共有 URL にはプロジェクト名が含まれません。

**共有 URL には、Cosense のユーザー名も含まれます** (合算とプロジェクト別の両方)。誰の草か
分かるようにするため、画像に `@<ユーザー名>` と描きます。プロジェクト名と同じく、サーバはこの名前を
保存せず、画像を描くときに受け取って使うだけです。**見せたくないときは、URL から `u=...` を
削ってください。**

## 第三者への提供

しません。広告も解析サービスも使いません。

インフラストラクチャとして Cloudflare (Workers と D1) を使い、認証に Google の OpenID Connect を
使います。それ以外にデータが渡ることはありません。

## データの削除

**サーバのデータ**は、管理のページ (`https://grass.soui.dev/account`) からすべて削除できます。
Google でサインインすると、登録した端末の一覧・共有 URL・削除の操作ができます。
削除すると、日ごとの集計値・ビットマップ・共有 URL・登録した端末の鍵がすべて消え、
共有 URL の草も日ごとの数値も見られなくなります。端末ごとの失効も同じ画面からできます。

**お使いのブラウザに残る記録**は、Cosense のページメニュー「cosense-grass」→「設定」から消せます。
ブラウザの中にしかないので、サーバからは消せません。同じ画面から、その端末の登録だけを外すこともできます。

## 数値の正確性について

記録される活動量は**利用者のブラウザからの自己申告**で、サーバに検証する手段がありません。
**評価や比較の根拠に使えるものではありません。**

## 免責

これは無償で提供される個人のプロジェクトです。可用性やデータの保全を保証しません。
サーバの無料枠の上限に達した日は記録が受け付けられず、翌日に再送されます。

## 連絡先

[GitHub の Issue](https://github.com/shinyaoguri/cosense-contribution-graph/issues) から
連絡してください。

## 変更

内容を変更した場合は、GitHub のリポジトリの履歴に残ります。
重要な変更があるときはリポジトリで告知します。

## Summary in English

cosense-grass visualizes your activity on Cosense (formerly Scrapbox) as a contribution graph ("grass").
It is a personal project and is not affiliated with Cosense or Helpfeel Inc.

- **Google user data we access:** Google Sign-In is used only to link your devices to one account.
  We request the `openid` scope only and receive only the account identifier (`sub`). We do not access your email address, name, or profile picture
- **How we use it:** We derive an internal user ID from `sub` with a keyed hash (HMAC), so that records from your devices are merged into one graph.
  We do not use it for advertising, profiling, or machine learning
- **Sharing:** We do not share, transfer, or sell Google user data to any third party
- **Protection:** All traffic uses HTTPS. We never store `sub` itself or the Google ID token; only the irreversible HMAC result is stored
- **Retention and deletion:** The internal user ID is kept until you delete your data. You can delete all server-side data at any time
  from `https://grass.soui.dev/account`
- **Other data:** We store per-minute activity bitmaps (kept for 90 days) and daily totals, device public keys, and a time zone.
  Daily totals include how many minutes you wrote on pages you created that day and on pages created by others, and how many links you created.
  We never receive page titles, page contents, page authors, link targets, or project names
- Our use of information received from Google APIs adheres to the
  [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements
- **Contact:** [GitHub Issues](https://github.com/shinyaoguri/cosense-contribution-graph/issues)
