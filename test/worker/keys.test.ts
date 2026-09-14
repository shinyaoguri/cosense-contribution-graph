import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kidOf } from "../../src/shared/ids.ts";
import { exportPublicKey, generateSigningKeyPair, sign, verify } from "../../src/shared/sign.ts";
import { d1KeyResolver } from "../../src/worker/keys.ts";
import { randomUid } from "./beacon-helpers.ts";

async function register(uid: string, pubkey?: Uint8Array<ArrayBuffer>) {
  const pair = await generateSigningKeyPair();
  const publicKey = await exportPublicKey(pair.publicKey);
  const kid = await kidOf(publicKey);
  await env.DB.prepare("INSERT INTO keys (uid, kid, pubkey, created) VALUES (?, ?, ?, 0)")
    .bind(uid, kid, pubkey ?? publicKey)
    .run();
  return { pair, kid };
}

describe("keys テーブルの公開鍵", () => {
  const resolve = d1KeyResolver(env.DB);

  it("登録した (uid, kid) なら、その鍵で検証できる", async () => {
    const uid = randomUid();
    const { pair, kid } = await register(uid);

    const key = await resolve(uid, kid);
    const signature = await sign(pair.privateKey, "x");
    expect(key && (await verify(key, signature, "x"))).toBe(true);
  });

  it("**同じ kid でも、登録していない uid には鍵を返さない**", async () => {
    const { kid } = await register(randomUid());
    expect(await resolve(randomUid(), kid)).toBeUndefined();
  });

  it("知らない kid は undefined", async () => {
    const uid = randomUid();
    await register(uid);
    expect(await resolve(uid, "0123456789abcdef")).toBeUndefined();
  });

  it("保存された公開鍵が 65 バイトでない・曲線上の点でないなら、例外にせず undefined", async () => {
    const short = randomUid();
    const { kid: shortKid } = await register(short, new Uint8Array(64));
    expect(await resolve(short, shortKid)).toBeUndefined();

    const notOnCurve = new Uint8Array(65).fill(1);
    notOnCurve[0] = 0x04;
    const offCurve = randomUid();
    const { kid: offCurveKid } = await register(offCurve, notOnCurve);
    expect(await resolve(offCurve, offCurveKid)).toBeUndefined();
  });

  it("D1 が失敗したら throw する (受け口が 500 にする)", async () => {
    const db = {
      prepare: () => {
        throw new Error("D1 が落ちた");
      },
    } as unknown as D1Database;
    await expect(d1KeyResolver(db)(randomUid(), "0123456789abcdef")).rejects.toThrow();
  });
});
