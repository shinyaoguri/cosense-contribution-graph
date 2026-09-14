import { describe, expect, it } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { kidOf } from "../../src/shared/ids.ts";
import { exportPublicKey, generateSigningKeyPair } from "../../src/shared/sign.ts";
import { type DeviceRecord, parseDeviceRecord } from "../../src/userscript/keys.ts";

const UID = encodeBase64url(new Uint8Array(20).fill(3));

async function record(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const pair = await generateSigningKeyPair();
  const publicKey = await exportPublicKey(pair.publicKey);
  const value: DeviceRecord = {
    v: 1,
    uid: UID,
    kid: await kidOf(publicKey),
    privateKey: pair.privateKey,
    publicKey,
    enrolledAt: "2026-09-15T00:00:00.000Z",
  };
  return { ...value, ...overrides };
}

describe("parseDeviceRecord", () => {
  it("保存した形なら found", async () => {
    const value = await record();
    const read = await parseDeviceRecord(value);
    expect(read.kind).toBe("found");
    expect(read.kind === "found" && read.record.kid).toBe(value.kid);
  });

  it("何も無ければ missing", async () => {
    expect(await parseDeviceRecord(undefined)).toEqual({ kind: "missing" });
  });

  it("**知らない版は newer** (上書きしない)", async () => {
    expect(await parseDeviceRecord(await record({ v: 2 }))).toEqual({ kind: "newer" });
  });

  it.each([
    ["オブジェクトでない", () => Promise.resolve("device")],
    ["null", () => Promise.resolve(null)],
    ["v が無い", () => record({ v: undefined })],
    ["uid の形が違う", () => record({ uid: "short" })],
    ["kid が公開鍵と合わない", () => record({ kid: "0123456789abcdef" })],
    ["公開鍵が 64 バイト", () => record({ publicKey: new Uint8Array(64) })],
    [
      "公開鍵が配列",
      async () => record({ publicKey: [...((await record()).publicKey as Uint8Array)] }),
    ],
    ["秘密鍵が無い", () => record({ privateKey: undefined })],
    ["enrolledAt が無い", () => record({ enrolledAt: undefined })],
  ])("%s なら invalid", async (_, make) => {
    expect(await parseDeviceRecord(await make())).toEqual({ kind: "invalid" });
  });

  it("**秘密鍵の代わりに公開鍵が入っていたら invalid** (署名できない)", async () => {
    const pair = await generateSigningKeyPair();
    expect(await parseDeviceRecord(await record({ privateKey: pair.publicKey }))).toEqual({
      kind: "invalid",
    });
  });

  it("ECDSA 以外の鍵は invalid", async () => {
    const hmac = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    expect(await parseDeviceRecord(await record({ privateKey: hmac }))).toEqual({
      kind: "invalid",
    });
  });
});
