/**
 * 人が開くページへのリンク。Worker のトップ (`site.ts`) と UserScript の草のダイアログが同じものを使う。
 *
 * 両 lib で型検査される。
 */

/** プライバシーポリシー (ADR-0018・0022)。英語。Worker が `docs/privacy.en.md` を配信する */
export const PRIVACY_PATH = "/privacy";

/** 日本語のプライバシーポリシー (ADR-0022)。`/privacy` は英語で、Google の同意画面に登録してある */
export const PRIVACY_JA_PATH = "/ja/privacy";

/** 配布ページのある公開プロジェクト (ADR-0005)。導入の手順もここにある */
export const DISTRIBUTION_URL = "https://scrapbox.io/cosense-grass/";

/** ソースコードと Issue */
export const REPOSITORY_URL = "https://github.com/shinyaoguri/cosense-contribution-graph";
