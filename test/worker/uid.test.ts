import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { isValidUid } from "../../src/shared/ids.ts";
import { uidOf } from "../../src/worker/uid.ts";

describe("uidOf", () => {
  it("**既知の答えと一致する** (鍵は秘密の文字列の UTF-8。変えると全員の uid が変わる)", async () => {
    // printf 'google:1234567890' | openssl dgst -sha256 -hmac 'test-worker-secret' -binary
    //   | head -c 20 | base64 | tr '+/' '-_' | tr -d '='
    expect(await uidOf("test-worker-secret", "1234567890")).toBe("ngL_NvW9yXXL0otmMRnPzFAyiCE");
  });

  it("27 文字の正規な uid になる", async () => {
    const uid = await uidOf(env.WORKER_SECRET, "109876543210987654321");
    expect(uid).toHaveLength(27);
    expect(isValidUid(uid)).toBe(true);
  });

  it("同じ sub なら同じ uid (2 台目のデバイスが同じ草に合流する)", async () => {
    expect(await uidOf(env.WORKER_SECRET, "42")).toBe(await uidOf(env.WORKER_SECRET, "42"));
  });

  it("sub か秘密が違えば別の uid", async () => {
    const base = await uidOf("secret-a", "42");
    expect(await uidOf("secret-a", "43")).not.toBe(base);
    expect(await uidOf("secret-b", "42")).not.toBe(base);
  });

  it("空の秘密と空の sub は例外", async () => {
    await expect(uidOf("", "42")).rejects.toThrow(RangeError);
    await expect(uidOf("secret", "")).rejects.toThrow(RangeError);
  });
});
