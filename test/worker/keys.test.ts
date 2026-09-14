import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { kidOf } from "../../src/shared/ids.ts";
import { exportPublicKey, generateSigningKeyPair, sign, verify } from "../../src/shared/sign.ts";
import { trialKeyResolver } from "../../src/worker/keys.ts";

async function trialKey() {
  const pair = await generateSigningKeyPair();
  const publicKey = await exportPublicKey(pair.publicKey);
  return { pair, configured: encodeBase64url(publicKey), kid: await kidOf(publicKey) };
}

describe("試験用の公開鍵", () => {
  it("kid が一致すれば、どの uid にも検証できる鍵を返す", async () => {
    const { pair, configured, kid } = await trialKey();
    const resolve = trialKeyResolver(configured);

    const key = await resolve("any-uid", kid);
    expect(key).toBeDefined();
    const signature = await sign(pair.privateKey, "x");
    expect(key && (await verify(key, signature, "x"))).toBe(true);
    expect(await resolve("another-uid", kid)).toBe(key);
  });

  it("kid が違えば undefined", async () => {
    const { configured } = await trialKey();
    expect(await trialKeyResolver(configured)("uid", "0123456789abcdef")).toBeUndefined();
  });

  it("**空 (本番の既定) なら、どの kid にも鍵を返さない**", async () => {
    const { kid } = await trialKey();
    expect(await trialKeyResolver("")("uid", kid)).toBeUndefined();
  });

  it("形の違う値と、65 バイトでも曲線上の点でない値は、例外にせず undefined", async () => {
    const notOnCurve = new Uint8Array(65).fill(1);
    notOnCurve[0] = 0x04;
    const resolve = trialKeyResolver(encodeBase64url(notOnCurve));

    expect(await resolve("uid", await kidOf(notOnCurve))).toBeUndefined();
    expect(await trialKeyResolver("not base64url")("uid", "0123456789abcdef")).toBeUndefined();
    expect(await trialKeyResolver(encodeBase64url(new Uint8Array(64)))("uid", "x")).toBeUndefined();
  });
});

describe("wrangler.jsonc の試験用の公開鍵", () => {
  it("**書き写し間違いが無い** (読み込めて、持ち主のブラウザが出した kid と一致する)", async () => {
    const configured: string = env.TRIAL_PUBLIC_KEY;
    // Cosense の「草: 記録の疎通確認」のダイアログに出た kid (Issue #36)
    const key = await trialKeyResolver(configured)("any-uid", "2039144416f25f35");
    expect(key).toBeDefined();
  });
});
