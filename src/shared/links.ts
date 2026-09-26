/**
 * 人が開くページへのリンク。Worker のトップ (`site.ts`) と UserScript の草のダイアログが同じものを使う。
 *
 * 両 lib で型検査される。
 */

/** プライバシーポリシー (ADR-0018)。Worker が `docs/privacy.md` を配信する */
export const PRIVACY_PATH = "/privacy";

/** 配布ページのある公開プロジェクト (ADR-0005)。導入の手順もここにある */
export const DISTRIBUTION_URL = "https://scrapbox.io/cosense-grass/";

/** ソースコードと Issue */
export const REPOSITORY_URL = "https://github.com/shinyaoguri/cosense-contribution-graph";
