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
