import { afterEach, describe, expect, it } from "vitest";
import { BUTTON_CLASS, DIALOG_ATTRIBUTE, styleDialog } from "../../src/userscript/dialog.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("styleDialog (#175)", () => {
  it("**印と、その印に範囲を絞った <style> を先頭に 1 つ入れる**", () => {
    const dialog = document.createElement("dialog");
    dialog.append(document.createElement("h2"));
    styleDialog(dialog);

    expect(dialog.hasAttribute(DIALOG_ATTRIBUTE)).toBe(true);
    const style = dialog.firstElementChild;
    expect(style?.tagName).toBe("STYLE");
    const css = style?.textContent ?? "";
    // どの規則も印の中だけに効く (Cosense のページの要素を巻き込まない)
    for (const rule of css.split("\n")) {
      expect(rule.startsWith(`dialog[${DIALOG_ATTRIBUTE}]`)).toBe(true);
    }
    // Cosense の .modal-content と .btn-default.btn-sm の値
    expect(css).toContain("border: 1px solid rgba(0, 0, 0, 0.2)");
    expect(css).toContain("box-shadow: 0 3px 9px rgba(0, 0, 0, 0.5)");
    expect(css).toContain("::backdrop");
    expect(css).toContain(`.${BUTTON_CLASS}`);
    expect(css).toContain(":focus-visible");
  });

  it("何度呼んでも <style> は 1 つ", () => {
    const dialog = document.createElement("dialog");
    styleDialog(dialog);
    styleDialog(dialog);
    expect(dialog.querySelectorAll("style")).toHaveLength(1);
  });
});
