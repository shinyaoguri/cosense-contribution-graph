import { describe, expect, it } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { kidOf, UID_BYTES } from "../../src/shared/ids.ts";
import { PURGE_PATH, parsePurgeQuery, purgeWidth } from "../../src/shared/purge.ts";
import { exportPublicKey, generateSigningKeyPair } from "../../src/shared/sign.ts";
import type { ImageResult } from "../../src/userscript/image.ts";
import type { DeviceRead, DeviceRecord } from "../../src/userscript/keys.ts";
import { createPurger, PURGED_KEYS } from "../../src/userscript/purge.ts";

const UID = encodeBase64url(new Uint8Array(UID_BYTES).fill(4));

const NOW = new Date("2026-09-15T03:00:00Z");

async function device(): Promise<DeviceRecord> {
  const pair = await generateSigningKeyPair();
  const publicKey = await exportPublicKey(pair.publicKey);
  return {
    v: 1,
    uid: UID,
    kid: await kidOf(publicKey),
    privateKey: pair.privateKey,
    publicKey,
    enrolledAt: "2026-09-14T00:00:00.000Z",
  };
}

type Options = {
  readonly read?: DeviceRead | "throws";
  readonly image?: ImageResult;
  readonly clearFails?: boolean;
  readonly removeFails?: boolean;
};

function setup(options: Options = {}) {
  const urls: string[] = [];
  const removed: string[] = [];
  const cleared = { count: 0 };
  // 記録が入っている状態から始める
  const stored = new Map<string, string>(PURGED_KEYS.map((key) => [key, "{}"]));
  const purger = createPurger({
    keys: {
      read: async () => {
        if (options.read === "throws") {
          throw new Error("IndexedDB");
        }
        return options.read ?? { kind: "missing" };
      },
      clear: async () => {
        if (options.clearFails) {
          throw new Error("IndexedDB");
        }
        cleared.count++;
      },
    },
    storage: {
      removeItem: (key) => {
        if (options.removeFails) {
          throw new Error("removeItem");
        }
        removed.push(key);
        stored.delete(key);
      },
    },
    sendImage: async (url) => {
      urls.push(url);
      return options.image ?? { kind: "loaded", width: purgeWidth({ deleted: true }) };
    },
    now: () => NOW,
  });
  return { purger, urls, removed, cleared, stored };
}

describe("全データの削除", () => {
  it("**この端末の鍵で署名して送り、成功したら localStorage の 4 つのキーと鍵を消す**", async () => {
    const record = await device();
    const t = setup({ read: { kind: "found", record } });

    expect(await t.purger.purgeAll()).toBe("purged");

    const url = new URL(t.urls[0] ?? "");
    expect(url.pathname).toBe(PURGE_PATH);
    const parsed = parsePurgeQuery(url.searchParams);
    if (!parsed.ok) {
      throw new Error(`組み立てた URL を読めない: ${parsed.reason}`);
    }
    expect(parsed.purge).toMatchObject({
      uid: UID,
      kid: record.kid,
      time: Math.floor(NOW.getTime() / 1000),
    });
    expect(t.removed).toEqual([...PURGED_KEYS]);
    expect(t.stored.size).toBe(0);
    expect(t.cleared.count).toBe(1);
  });

  it("**未登録なら送らず、このブラウザの記録だけ消す**", async () => {
    const t = setup({ read: { kind: "missing" } });

    expect(await t.purger.purgeAll()).toBe("local-only");
    expect(t.urls).toEqual([]);
    expect(t.stored.size).toBe(0);
    // 鍵は無いので触らない
    expect(t.cleared.count).toBe(0);
  });

  it("知らない版の鍵なら何もしない", async () => {
    const t = setup({ read: { kind: "newer" } });

    expect(await t.purger.purgeAll()).toBe("newer");
    expect(t.removed).toEqual([]);
  });

  it("IndexedDB を開けなければ storage", async () => {
    const t = setup({ read: "throws" });

    expect(await t.purger.purgeAll()).toBe("storage");
    expect(t.removed).toEqual([]);
  });

  it.each([
    ["error", { kind: "error" } as ImageResult, "error"],
    ["timeout", { kind: "timeout" } as ImageResult, "timeout"],
    ["取り決めの外の幅", { kind: "loaded", width: 99 } as ImageResult, "unexpected"],
  ])(
    "応答が %s なら**ローカルの記録も消さない** (サーバに残ったまま手元だけ消えない)",
    async (_name, image, expected) => {
      const record = await device();
      const t = setup({ read: { kind: "found", record }, image });

      expect(await t.purger.purgeAll()).toBe(expected);
      expect(t.removed).toEqual([]);
      expect(t.cleared.count).toBe(0);
    },
  );

  it("サーバは消したがローカルを消しきれなければ local-failed", async () => {
    const record = await device();
    const t = setup({ read: { kind: "found", record }, clearFails: true });

    expect(await t.purger.purgeAll()).toBe("local-failed");
  });

  it("**localStorage が消せなくても鍵は消しに行く** (途中で止めない)", async () => {
    const record = await device();
    const t = setup({ read: { kind: "found", record }, removeFails: true });

    expect(await t.purger.purgeAll()).toBe("local-failed");
    expect(t.cleared.count).toBe(1);
  });
});
