import { describe, expect, it } from "vitest";
import type { SendStatus } from "../../src/userscript/sender.ts";
import {
  describeSettings,
  REVOKE_CONFIRM,
  REVOKE_LABEL,
  SIGN_IN_LABEL,
} from "../../src/userscript/settings.ts";
import { DEFAULT_SETTINGS, type SettingsRead } from "../../src/userscript/settings-store.ts";

const ENROLLED: SendStatus = {
  kind: "enrolled",
  kid: "0123456789abcdef",
  graphUrl: "https://grass.soui.dev/v1/g/0123456789abcdef0123456789abcdef.svg",
  projects: [],
  todaySends: 0,
  pendingDays: 0,
};

const settings = (countRead: boolean, newer = false): SettingsRead => ({
  settings: { ...DEFAULT_SETTINGS, countRead },
  newer,
});

describe("この端末", () => {
  it("**未登録なら、登録を促してサインインのボタンを出す**", () => {
    const model = describeSettings({ kind: "not-enrolled" }, settings(true));

    expect(model.device.kind).toBe("not-enrolled");
    expect(model.signIn).toEqual({ label: SIGN_IN_LABEL });
  });

  it("**登録済みなら kid を出し、サインインし直せる** (鍵が使えなくなったときの手当て)", () => {
    const model = describeSettings(ENROLLED, settings(true));

    expect(model.device).toMatchObject({ kind: "enrolled", kid: "0123456789abcdef" });
    expect(model.signIn?.label).toBe("サインインし直す");
  });

  it("**登録済みのときだけ失効を出す** (登録が無ければ取り消すものが無い)", () => {
    expect(describeSettings(ENROLLED, settings(true)).revoke).toEqual({
      label: REVOKE_LABEL,
      confirm: REVOKE_CONFIRM,
    });
    expect(describeSettings({ kind: "not-enrolled" }, settings(true)).revoke).toBeUndefined();
    expect(describeSettings({ kind: "storage" }, settings(true)).revoke).toBeUndefined();
  });

  it.each([
    ["newer-key", "新しい版"],
    ["newer-sent", "新しい版"],
    ["storage", "保存領域"],
  ] as const)(
    "%s は文言だけを出し、**サインインのボタンは出さない** (押しても直らない)",
    (kind, text) => {
      const model = describeSettings({ kind }, settings(true));

      expect(model.device.kind).toBe("message");
      expect(model.device.lines.join("")).toContain(text);
      expect(model.signIn).toBeUndefined();
    },
  );
});

describe("数えるもの", () => {
  it.each([true, false])("read 計上の今の値をそのまま出す (%s)", (countRead) => {
    const model = describeSettings(ENROLLED, settings(countRead));

    expect(model.countRead).toEqual({ value: countRead, editable: true, note: undefined });
  });

  it("**知らない版の設定があるときは変えさせない** (書くと新しい版の形を壊す)", () => {
    const model = describeSettings(ENROLLED, settings(false, true));

    expect(model.countRead.value).toBe(false);
    expect(model.countRead.editable).toBe(false);
    expect(model.countRead.note).toContain("新しい版");
  });
});
