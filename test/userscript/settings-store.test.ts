import { describe, expect, it } from "vitest";
import {
  createSettings,
  DEFAULT_SETTINGS,
  readSettings,
  SETTINGS_KEY,
  SETTINGS_VERSION,
  writeSettings,
} from "../../src/userscript/settings-store.ts";

/** 偽の localStorage。書き込みで例外を投げられる */
function setup(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) {
    map.set(SETTINGS_KEY, initial);
  }
  const state = { throws: false };
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (state.throws) {
        throw new Error("容量超過");
      }
      map.set(key, value);
    },
  };
  return { map, state, storage };
}

describe("読む", () => {
  it("**何も無ければ既定 (読みを数える)**", () => {
    const t = setup();
    expect(readSettings(t.storage)).toEqual({ settings: DEFAULT_SETTINGS, newer: false });
  });

  it.each([
    ["壊れた JSON", "{"],
    ["null", "null"],
    ["配列でも数値でもない値", '"text"'],
    ["countRead が boolean でない", `{"v":${SETTINGS_VERSION},"countRead":"no"}`],
  ])("%s なら既定", (_name, stored) => {
    const t = setup(stored);
    expect(readSettings(t.storage).settings).toEqual(DEFAULT_SETTINGS);
  });

  it("書かれた値を読む", () => {
    const t = setup(`{"v":${SETTINGS_VERSION},"countRead":false}`);
    expect(readSettings(t.storage)).toEqual({
      settings: { v: SETTINGS_VERSION, countRead: false },
      newer: false,
    });
  });

  it("**知らない版でも countRead は尊重する** (数えないでほしい、という意思表示を版で覆さない)", () => {
    const t = setup(`{"v":${SETTINGS_VERSION + 1},"countRead":false}`);
    expect(readSettings(t.storage)).toEqual({
      settings: { v: SETTINGS_VERSION, countRead: false },
      newer: true,
    });
  });
});

describe("書く", () => {
  it("書ける", () => {
    const t = setup();
    expect(writeSettings(t.storage, { v: SETTINGS_VERSION, countRead: false })).toBe("written");
    expect(t.map.get(SETTINGS_KEY)).toBe(`{"v":${SETTINGS_VERSION},"countRead":false}`);
  });

  it("**知らない版の設定があれば書かない**", () => {
    const t = setup(`{"v":${SETTINGS_VERSION + 1},"countRead":true}`);
    expect(writeSettings(t.storage, { v: SETTINGS_VERSION, countRead: false })).toBe("blocked");
    expect(t.map.get(SETTINGS_KEY)).toBe(`{"v":${SETTINGS_VERSION + 1},"countRead":true}`);
  });

  it("例外になったら failed (容量超過など)", () => {
    const t = setup();
    t.state.throws = true;
    expect(writeSettings(t.storage, DEFAULT_SETTINGS)).toBe("failed");
  });
});

describe("createSettings", () => {
  it("**書いた値をすぐ読み直せる** (別のタブが書いた値も、読むたびに拾う)", () => {
    const t = setup();
    const settings = createSettings(t.storage);

    expect(settings.read().settings.countRead).toBe(true);
    expect(settings.setCountRead(false)).toBe("written");
    expect(settings.read().settings.countRead).toBe(false);

    t.map.set(SETTINGS_KEY, `{"v":${SETTINGS_VERSION},"countRead":true}`);
    expect(settings.read().settings.countRead).toBe(true);
  });
});
