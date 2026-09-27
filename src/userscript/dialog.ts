/**
 * `<dialog>` の外 (背景) のクリックで閉じる (2026-09-24)。草のダイアログと設定のダイアログが使う。
 *
 * - **背景のクリックは、target が `<dialog>` 自身で、位置がその矩形の外のもの。** `showModal` の背景
 *   (`::backdrop`) は `<dialog>` の一部として扱われる。矩形も見るのは、`<dialog>` の余白やスクロールバーの
 *   クリックも target が `<dialog>` 自身になるため
 * - **押した位置も背景のときだけ閉じる。** 中の文字を選んだまま外で離すと、click は両者の共通の祖先
 *   (`<dialog>`) に届くので、離した位置だけ見ると閉じてしまう
 * - `closedby="any"` はブラウザの対応が揃っていないので使わない
 * - **サインインのダイアログには付けない** — 登録の途中で外を誤ってクリックすると、流れが中断される
 */
export function closeOnBackdropClick(dialog: HTMLDialogElement, close: () => void): void {
  const onBackdrop = (event: MouseEvent) => {
    if (event.target !== dialog) {
      return false;
    }
    const rect = dialog.getBoundingClientRect();
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  };
  let pressedOnBackdrop = false;
  dialog.addEventListener("pointerdown", (event) => {
    pressedOnBackdrop = onBackdrop(event);
  });
  dialog.addEventListener("click", (event) => {
    const pressed = pressedOnBackdrop;
    pressedOnBackdrop = false;
    if (pressed && onBackdrop(event)) {
      close();
    }
  });
}

/** 見た目を付けたダイアログの印。`<style>` の規則はこの印の中だけに効かせる */
export const DIALOG_ATTRIBUTE = "data-cosense-grass-dialog";

/** リンクをボタンの見た目にするときのクラス (JSON の「開く」) */
export const BUTTON_CLASS = "cosense-grass-button";

const DIALOG = `dialog[${DIALOG_ATTRIBUTE}]`;
const BUTTONS = `${DIALOG} :is(button, .${BUTTON_CLASS})`;

/**
 * Cosense (Bootstrap 3 系) の `.modal-content` と `.btn-default.btn-sm` の値 (#175。2026-09-27 に計算値を読んで確かめた)。
 * **Cosense のクラスは借りない** — 借りると Cosense の CSS の変更でこちらが崩れ、Cosense の外 (確認用の HTML) で見た目を確かめられない。
 * 暗幕は Cosense の 0.8 より薄い Bootstrap の既定の 0.5 にする (ページの草が透けて見える方が、どこから開いたか分かる)
 */
const DIALOG_CSS = [
  `${DIALOG} { border: 1px solid rgba(0, 0, 0, 0.2); border-radius: 6px; box-shadow: 0 3px 9px rgba(0, 0, 0, 0.5); background: #fff; color: #333; padding: 20px; }`,
  `${DIALOG}::backdrop { background: rgba(0, 0, 0, 0.5); }`,
  `${BUTTONS} { display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; font: inherit; font-size: 12px; line-height: 18px; color: #333; background: #fff; border: 1px solid #ccc; border-radius: 3px; cursor: pointer; text-decoration: none; white-space: nowrap; }`,
  `${BUTTONS}:hover:not(:disabled) { background: #e6e6e6; border-color: #adadad; text-decoration: none; }`,
  `${BUTTONS}:focus-visible { outline: 2px solid #3d72f5; outline-offset: 1px; }`,
  `${DIALOG} button:disabled { opacity: 0.65; cursor: not-allowed; }`,
  // Safari は summary を `display: flex` にしても既定の三角を出すので、疑似要素で消す (#172)
  `${DIALOG} summary::-webkit-details-marker { display: none; }`,
].join("\n");

/**
 * ダイアログの枠とボタンを Cosense の見た目に合わせる (#175)。草・設定・サインインの 3 つが使う。
 * `:hover`・`:focus-visible`・`::backdrop` はインラインの style で書けないので、印で範囲を絞った `<style>` を 1 つ先頭に入れる。
 * 何度呼んでも 1 つだけ
 */
export function styleDialog(dialog: HTMLDialogElement): void {
  if (dialog.hasAttribute(DIALOG_ATTRIBUTE)) {
    return;
  }
  dialog.setAttribute(DIALOG_ATTRIBUTE, "");
  const style = dialog.ownerDocument.createElement("style");
  style.textContent = DIALOG_CSS;
  dialog.prepend(style);
}
