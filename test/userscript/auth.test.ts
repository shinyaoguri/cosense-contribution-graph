import { describe, expect, it } from "vitest";
import { AUTH_MESSAGE_TYPE, encodeAuthCode } from "../../src/shared/auth.ts";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { parseEnrollQuery } from "../../src/shared/enroll.ts";
import { PH_ALL, publicIdOf } from "../../src/shared/ids.ts";
import { generateSigningKeyPair, importVerifyKey, verify } from "../../src/shared/sign.ts";
import {
  createSignIn,
  readAuthMessage,
  type SignInDependencies,
  type SignInView,
} from "../../src/userscript/auth.ts";
import type { ImageResult } from "../../src/userscript/image.ts";
import { type DeviceRecord, parseDeviceRecord } from "../../src/userscript/keys.ts";
import { graphUrl, WORKER_ORIGIN } from "../../src/userscript/worker-origin.ts";

function randomCode() {
  const uid = encodeBase64url(crypto.getRandomValues(new Uint8Array(20)));
  const token = encodeBase64url(crypto.getRandomValues(new Uint8Array(16)));
  return { uid, token, text: encodeAuthCode({ uid, token }) };
}

type Handlers = Parameters<SignInView["open"]>[1];

/** 偽のポップアップ・メッセージ・ダイアログ・保存・画像。何が起きたかを記録する */
function harness(
  options: {
    popupBlocked?: boolean;
    stored?: unknown;
    readFails?: boolean;
    writeFails?: boolean;
    image?: ImageResult | ((url: string) => ImageResult);
    confirm?: boolean;
  } = {},
) {
  const popup = {
    closes: 0,
    close() {
      this.closes++;
    },
  };
  const opened: string[] = [];
  const listeners = new Set<(event: MessageEvent) => void>();
  const logs: string[] = [];
  const view = {
    opens: [] as { popupBlocked: boolean; startUrl: string }[],
    handlers: undefined as Handlers | undefined,
    statuses: [] as string[],
    busy: [] as boolean[],
    confirms: [] as string[],
    finished: undefined as { lines: readonly string[]; link?: string } | undefined,
    closes: 0,
  };
  const storage = { value: options.stored, writes: [] as DeviceRecord[] };
  const images: string[] = [];
  const generated = { count: 0 };

  const deps: SignInDependencies = {
    openPopup: (url) => {
      opened.push(url);
      return options.popupBlocked ? null : popup;
    },
    messages: {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    },
    view: {
      open: (state, handlers) => {
        view.opens.push(state);
        view.handlers = handlers;
      },
      status: (text) => view.statuses.push(text),
      busy: (on) => view.busy.push(on),
      confirm: async (text) => {
        view.confirms.push(text);
        return options.confirm ?? false;
      },
      finish: (lines, link) => {
        view.finished = { lines, link };
      },
      close: () => {
        view.closes++;
      },
    },
    keys: {
      read: async () => {
        if (options.readFails) {
          throw new Error("IndexedDB");
        }
        return parseDeviceRecord(storage.value);
      },
      write: async (record) => {
        if (options.writeFails) {
          throw new Error("quota");
        }
        storage.writes.push(record);
        storage.value = record;
      },
    },
    generateKeyPair: () => {
      generated.count++;
      return generateSigningKeyPair();
    },
    sendImage: async (url) => {
      images.push(url);
      const image = options.image ?? { kind: "loaded", width: 17 };
      return typeof image === "function" ? image(url) : image;
    },
    now: () => new Date("2026-09-15T01:00:00Z"),
    log: (message) => logs.push(message),
  };

  function post(data: unknown, from: { origin?: string; source?: unknown } = {}) {
    for (const listener of [...listeners]) {
      listener({
        origin: from.origin ?? WORKER_ORIGIN,
        source: from.source ?? popup,
        data,
      } as MessageEvent);
    }
  }

  return {
    deps,
    popup,
    opened,
    listeners,
    view,
    storage,
    images,
    generated,
    logs,
    post,
    signIn: createSignIn(deps),
  };
}

const message = (code: string) => ({ type: AUTH_MESSAGE_TYPE, v: 1, code });

async function verifyEnrollUrl(url: string, uid: string, token: string) {
  const parsed = parseEnrollQuery(new URL(url).searchParams);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  expect(new URL(url).origin).toBe(WORKER_ORIGIN);
  expect(parsed.enrollment.uid).toBe(uid);
  expect(parsed.enrollment.token).toBe(token);
  const key = await importVerifyKey(parsed.enrollment.publicKey);
  expect(await verify(key, parsed.enrollment.signature, parsed.enrollment.signingInput)).toBe(true);
  return parsed.enrollment;
}

describe("createSignIn — ポップアップ", () => {
  it("**呼んだ同期区間でポップアップを開き、メッセージを待ち始める**", () => {
    const t = harness();
    void t.signIn();
    // await の前
    expect(t.opened).toEqual([`${WORKER_ORIGIN}/auth/start`]);
    expect(t.listeners.size).toBe(1);
    expect(t.view.opens).toEqual([
      { popupBlocked: false, startUrl: `${WORKER_ORIGIN}/auth/start` },
    ]);
  });

  it("**正しいメッセージで、登録する鍵で署名した URL を送り、17 なら保存する**", async () => {
    const t = harness();
    const code = randomCode();
    const done = t.signIn();
    t.post(message(code.text));

    expect(await done).toBe("added");
    expect(t.images).toHaveLength(1);
    const enrollment = await verifyEnrollUrl(t.images[0] ?? "", code.uid, code.token);

    expect(t.storage.writes).toHaveLength(1);
    const saved = t.storage.writes[0];
    expect(saved?.uid).toBe(code.uid);
    expect([...(saved?.publicKey ?? [])]).toEqual([...enrollment.publicKey]);
    expect(saved?.privateKey.extractable).toBe(false);
    expect(saved?.enrolledAt).toBe("2026-09-15T01:00:00.000Z");

    // ポップアップを閉じ、リスナーを外す
    expect(t.popup.closes).toBe(1);
    expect(t.listeners.size).toBe(0);
    expect(t.view.finished?.lines.join("\n")).toContain("新しく登録しました");
    expect(t.view.finished?.lines.join("\n")).toContain("ポップアップ");
    expect(t.view.finished?.link).toBe(graphUrl(await publicIdOf(code.uid, PH_ALL)));
  });

  it.each([
    ["オリジンが workers.dev", { origin: "https://cosense-grass.soui.workers.dev" }, undefined],
    ["オリジンが scrapbox.io", { origin: "https://scrapbox.io" }, undefined],
    ["送り元が別のウィンドウ", { source: {} }, undefined],
    ["type が違う", {}, { type: "other", v: 1 }],
    ["v が 2", {}, { type: AUTH_MESSAGE_TYPE, v: 2 }],
    ["data が文字列", {}, "code"],
    ["コードの形が違う", {}, { type: AUTH_MESSAGE_TYPE, v: 1, code: "short" }],
  ])("**%s のメッセージは無視し、その後の貼り付けは通る**", async (_, from, data) => {
    const t = harness();
    const code = randomCode();
    const done = t.signIn();
    t.post(data ?? message(code.text), from);
    expect(t.images).toHaveLength(0);
    expect(t.listeners.size).toBe(1);

    t.view.handlers?.submit(code.text);
    expect(await done).toBe("added");
    expect(t.view.finished?.lines.join("\n")).toContain("コードの貼り付け");
  });

  it("ポップアップの error は文言を出すだけで、貼り付けで続けられる", async () => {
    const t = harness();
    const code = randomCode();
    const done = t.signIn();
    t.post({ type: AUTH_MESSAGE_TYPE, v: 1, error: "expired" });
    t.post({ type: AUTH_MESSAGE_TYPE, v: 1, error: "unknown" });
    expect(t.view.statuses).toHaveLength(2);
    expect(t.view.statuses[0]).toContain("有効期限");
    expect(t.view.statuses[1]).toContain("失敗");

    t.view.handlers?.submit(code.text);
    expect(await done).toBe("added");
  });

  it("**メッセージと貼り付けの両方が来ても、登録のリクエストは 1 回**", async () => {
    const t = harness();
    const code = randomCode();
    const done = t.signIn();
    t.post(message(code.text));
    t.view.handlers?.submit(code.text);
    t.post(message(code.text));
    await done;
    expect(t.images).toHaveLength(1);
  });

  it("**ポップアップがブロックされたらリスナーを付けず、貼り付けで登録できる**", async () => {
    const t = harness({ popupBlocked: true });
    const code = randomCode();
    const done = t.signIn();
    expect(t.listeners.size).toBe(0);
    expect(t.view.opens[0]?.popupBlocked).toBe(true);

    t.view.handlers?.submit(`  ${code.text}\n`);
    expect(await done).toBe("added");
  });

  it("形の違う貼り付けは文言を出して待ち続ける", async () => {
    const t = harness();
    const code = randomCode();
    const done = t.signIn();
    t.view.handlers?.submit("not a code");
    expect(t.view.statuses.at(-1)).toContain("形が違います");
    expect(t.images).toHaveLength(0);
    t.view.handlers?.submit(code.text);
    expect(await done).toBe("added");
  });

  it("**やめたら、その後のメッセージを無視しポップアップを閉じる**", async () => {
    const t = harness();
    const code = randomCode();
    const done = t.signIn();
    t.view.handlers?.cancel();
    t.post(message(code.text));
    expect(await done).toBe("cancelled");
    expect(t.images).toHaveLength(0);
    expect(t.popup.closes).toBe(1);
    expect(t.view.closes).toBe(1);
  });

  it("流れの途中でもう一度押しても開かない。終わった後は開ける", async () => {
    const t = harness();
    const first = t.signIn();
    expect(await t.signIn()).toBe("busy");
    expect(t.opened).toHaveLength(1);
    t.view.handlers?.cancel();
    await first;
    void t.signIn();
    expect(t.opened).toHaveLength(2);
  });
});

describe("createSignIn — 鍵と保存", () => {
  async function storedRecord(uid: string): Promise<DeviceRecord> {
    const t = harness();
    const code = { ...randomCode(), uid };
    const done = t.signIn();
    t.view.handlers?.submit(encodeAuthCode({ uid, token: code.token }));
    await done;
    const record = t.storage.writes[0];
    if (!record) {
      throw new Error("保存されていない");
    }
    return record;
  }

  it("**同じ uid なら保存した鍵を使い回し、16 で「登録済み」。保存し直さない**", async () => {
    const code = randomCode();
    const stored = await storedRecord(code.uid);
    const t = harness({ stored, image: { kind: "loaded", width: 16 } });
    const done = t.signIn();
    t.post(message(code.text));

    expect(await done).toBe("known");
    expect(t.generated.count).toBe(0);
    const enrollment = await verifyEnrollUrl(t.images[0] ?? "", code.uid, code.token);
    expect([...enrollment.publicKey]).toEqual([...stored.publicKey]);
    expect(t.storage.writes).toHaveLength(0);
    expect(t.view.finished?.lines.join("\n")).toContain("登録済み");
  });

  it("**別の uid で登録済みなら確かめる。断れば送らず保存もしない**", async () => {
    const stored = await storedRecord(randomCode().uid);
    const t = harness({ stored, confirm: false });
    const done = t.signIn();
    t.post(message(randomCode().text));

    expect(await done).toBe("declined");
    expect(t.view.confirms).toHaveLength(1);
    expect(t.images).toHaveLength(0);
    expect(t.storage.writes).toHaveLength(0);
    expect(t.view.closes).toBe(1);
  });

  it("別の uid で登録済みでも、受け入れれば新しい鍵で登録して置き換える", async () => {
    const stored = await storedRecord(randomCode().uid);
    const t = harness({ stored, confirm: true });
    const code = randomCode();
    const done = t.signIn();
    t.post(message(code.text));

    expect(await done).toBe("added");
    expect(t.generated.count).toBe(1);
    expect(t.storage.writes[0]?.uid).toBe(code.uid);
    expect(t.storage.writes[0]?.kid).not.toBe(stored.kid);
  });

  it("**保存した鍵で署名できなければ、新しい鍵で送る** (リクエストは 1 回)", async () => {
    const code = randomCode();
    const stored = await storedRecord(code.uid);
    // 署名に使えない鍵にすり替える (形の判定は通るが sign が失敗する)
    const broken = {
      ...stored,
      privateKey: {
        type: "private",
        algorithm: { name: "ECDSA", namedCurve: "P-256" },
        usages: ["sign"],
        extractable: false,
      },
    };
    const t = harness({ stored: broken });
    const done = t.signIn();
    t.post(message(code.text));

    expect(await done).toBe("added");
    expect(t.images).toHaveLength(1);
    expect(t.generated.count).toBe(1);
    expect(t.storage.writes).toHaveLength(1);
  });

  it.each([
    ["画像にならない (期限切れ・使用済み)", { kind: "error" } as ImageResult, "rejected", "期限"],
    ["応答が無い", { kind: "timeout" } as ImageResult, "timeout", "応答がありません"],
    ["幅が想定外", { kind: "loaded", width: 1 } as ImageResult, "unexpected", "想定と違いました"],
  ])("**%s なら保存しない**", async (_, image, outcome, text) => {
    const t = harness({ image });
    const done = t.signIn();
    t.post(message(randomCode().text));
    expect(await done).toBe(outcome);
    expect(t.storage.writes).toHaveLength(0);
    expect(t.view.finished?.lines.join("\n")).toContain(text);
  });

  it("保存領域が開けなければ送らない", async () => {
    const t = harness({ readFails: true });
    const done = t.signIn();
    t.post(message(randomCode().text));
    expect(await done).toBe("storage");
    expect(t.images).toHaveLength(0);
  });

  it("新しい版の記録があれば上書きしない", async () => {
    const t = harness({ stored: { v: 2 } });
    const done = t.signIn();
    t.post(message(randomCode().text));
    expect(await done).toBe("newer");
    expect(t.images).toHaveLength(0);
    expect(t.storage.writes).toHaveLength(0);
  });

  it("登録できても保存に失敗したらそう伝える", async () => {
    const t = harness({ writeFails: true });
    const done = t.signIn();
    t.post(message(randomCode().text));
    expect(await done).toBe("storage");
    expect(t.view.finished?.lines.join("\n")).toContain("保存できませんでした");
  });

  it("**ログと画面に uid・トークン・コード・登録の URL を出さない**", async () => {
    const t = harness();
    const code = randomCode();
    const done = t.signIn();
    t.post(message(code.text));
    await done;

    const shown = [...t.logs, ...t.view.statuses, ...(t.view.finished?.lines ?? [])].join("\n");
    for (const secret of [code.uid, code.token, code.text, t.images[0] ?? ""]) {
      expect(secret).not.toBe("");
      expect(shown).not.toContain(secret);
    }
    expect(t.logs).toEqual(["[cosense-grass] サインイン: added"]);
  });
});

describe("readAuthMessage", () => {
  it("取り消しと期限切れはそのまま、知らない error は failed", () => {
    const popup = {};
    const read = (error: unknown) =>
      readAuthMessage(
        {
          origin: WORKER_ORIGIN,
          source: popup as MessageEventSource,
          data: { type: AUTH_MESSAGE_TYPE, v: 1, error },
        },
        popup,
      );
    expect(read("cancelled")).toEqual({ error: "cancelled" });
    expect(read("expired")).toEqual({ error: "expired" });
    expect(read("<script>")).toEqual({ error: "failed" });
  });

  it("ポップアップが無ければ何も読まない", () => {
    const code = randomCode();
    expect(
      readAuthMessage({ origin: WORKER_ORIGIN, source: null, data: message(code.text) }, null),
    ).toBeUndefined();
  });
});
