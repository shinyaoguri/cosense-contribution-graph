import { describe, expect, it } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { kidOf, UID_BYTES } from "../../src/shared/ids.ts";
import { parseRevokeQuery, REVOKE_PATH, revokeWidth } from "../../src/shared/revoke.ts";
import { exportPublicKey, generateSigningKeyPair, verify } from "../../src/shared/sign.ts";
import type { ImageResult } from "../../src/userscript/image.ts";
import type { DeviceRead, DeviceRecord } from "../../src/userscript/keys.ts";
import { createRevoker } from "../../src/userscript/revoke.ts";

const UID = encodeBase64url(new Uint8Array(UID_BYTES).fill(3));

const NOW = new Date("2026-09-15T02:00:00Z");

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
};

function setup(options: Options = {}) {
  const urls: string[] = [];
  const cleared = { count: 0 };
  const revoker = createRevoker({
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
    sendImage: async (url) => {
      urls.push(url);
      return options.image ?? { kind: "loaded", width: revokeWidth({ removed: true }) };
    },
    now: () => NOW,
  });
  return { revoker, urls, cleared };
}

describe("この端末の失効", () => {
  it("**この端末の鍵で署名して送り、成功したらローカルの鍵も消す**", async () => {
    const record = await device();
    const t = setup({ read: { kind: "found", record } });

    expect(await t.revoker.revokeThisDevice()).toBe("revoked");

    expect(t.urls).toHaveLength(1);
    const url = new URL(t.urls[0] ?? "");
    expect(url.pathname).toBe(REVOKE_PATH);
    const parsed = parseRevokeQuery(url.searchParams);
    if (!parsed.ok) {
      throw new Error(`組み立てた URL を読めない: ${parsed.reason}`);
    }
    // 署名する鍵と消す鍵は同じ (この端末)
    expect(parsed.revocation).toMatchObject({
      uid: UID,
      kid: record.kid,
      target: record.kid,
      time: Math.floor(NOW.getTime() / 1000),
    });
    const publicKey = await crypto.subtle.importKey(
      "raw",
      record.publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    expect(
      await verify(publicKey, parsed.revocation.signature, parsed.revocation.signingInput),
    ).toBe(true);
    expect(t.cleared.count).toBe(1);
  });

  it("**もう無かった (幅 16) ときもローカルの鍵を消す**", async () => {
    const record = await device();
    const t = setup({
      read: { kind: "found", record },
      image: { kind: "loaded", width: revokeWidth({ removed: false }) },
    });

    expect(await t.revoker.revokeThisDevice()).toBe("revoked");
    expect(t.cleared.count).toBe(1);
  });

  it.each([
    ["missing", { kind: "missing" } as DeviceRead, "not-enrolled"],
    ["invalid", { kind: "invalid" } as DeviceRead, "not-enrolled"],
    ["newer", { kind: "newer" } as DeviceRead, "newer"],
  ])("鍵が %s なら送らない", async (_name, read, expected) => {
    const t = setup({ read });

    expect(await t.revoker.revokeThisDevice()).toBe(expected);
    expect(t.urls).toEqual([]);
    expect(t.cleared.count).toBe(0);
  });

  it("IndexedDB を開けなければ storage", async () => {
    const t = setup({ read: "throws" });

    expect(await t.revoker.revokeThisDevice()).toBe("storage");
    expect(t.urls).toEqual([]);
  });

  it.each([
    ["error", { kind: "error" } as ImageResult, "error"],
    ["timeout", { kind: "timeout" } as ImageResult, "timeout"],
    ["取り決めの外の幅", { kind: "loaded", width: 99 } as ImageResult, "unexpected"],
  ])(
    "応答が %s なら**ローカルの鍵を消さない** (失効できていない)",
    async (_name, image, expected) => {
      const record = await device();
      const t = setup({ read: { kind: "found", record }, image });

      expect(await t.revoker.revokeThisDevice()).toBe(expected);
      expect(t.cleared.count).toBe(0);
    },
  );

  it("サーバは消したがローカルを消せなければ local-failed", async () => {
    const record = await device();
    const t = setup({ read: { kind: "found", record }, clearFails: true });

    expect(await t.revoker.revokeThisDevice()).toBe("local-failed");
  });
});
