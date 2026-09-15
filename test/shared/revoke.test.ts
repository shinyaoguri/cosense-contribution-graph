import { describe, expect, it } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { buildIngestUrl } from "../../src/shared/beacon.ts";
import { bitmapOf } from "../../src/shared/bits.ts";
import { kidOf, PH_ALL, UID_BYTES } from "../../src/shared/ids.ts";
import {
  buildRevokeUrl,
  parseRevokeQuery,
  REVOKE_PARAM,
  REVOKE_PATH,
  REVOKE_WIDTH_BASE,
  REVOKE_WINDOW_SECONDS,
  readRevokeWidth,
  revokeWidth,
} from "../../src/shared/revoke.ts";
import {
  exportPublicKey,
  generateSigningKeyPair,
  SIGNATURE_BYTES,
  sign,
  verify,
} from "../../src/shared/sign.ts";

// UserScript が組み立てた URL を Worker が同じ中身・同じ署名対象に読むことが前提。両環境で走らせる

const ORIGIN = "https://example.com";
const UID = encodeBase64url(new Uint8Array(UID_BYTES).fill(1));
const TIME = 1_789_000_000;

async function revokeUrl(overrides: Partial<{ uid: string; target: string; time: number }> = {}) {
  const pair = await generateSigningKeyPair();
  const kid = await kidOf(await exportPublicKey(pair.publicKey));
  const href = await buildRevokeUrl(
    ORIGIN,
    {
      uid: overrides.uid ?? UID,
      kid,
      target: overrides.target ?? kid,
      time: overrides.time ?? TIME,
    },
    (input) => sign(pair.privateKey, input),
  );
  return { url: new URL(href), pair, kid };
}

function withParam(url: URL, key: string, value: string): URLSearchParams {
  const search = new URLSearchParams(url.search);
  search.set(key, value);
  return search;
}

describe("組み立てと読み取り", () => {
  it("**組み立てた URL を読み戻せ、その鍵で署名が通る**", async () => {
    const { url, pair, kid } = await revokeUrl();

    expect(url.pathname).toBe(REVOKE_PATH);
    const parsed = parseRevokeQuery(url.searchParams);
    if (!parsed.ok) {
      throw new Error(`読めなかった: ${parsed.reason}`);
    }
    expect(parsed.revocation).toMatchObject({ uid: UID, kid, target: kid, time: TIME });
    expect(parsed.revocation.signature).toHaveLength(SIGNATURE_BYTES);
    expect(
      await verify(pair.publicKey, parsed.revocation.signature, parsed.revocation.signingInput),
    ).toBe(true);
  });

  it("**ほかの端末の kid も消せる** (登録は同じ uid の下にある)", async () => {
    const other = await kidOf(await exportPublicKey((await generateSigningKeyPair()).publicKey));
    const { url, kid } = await revokeUrl({ target: other });

    const parsed = parseRevokeQuery(url.searchParams);
    if (!parsed.ok) {
      throw new Error(`読めなかった: ${parsed.reason}`);
    }
    expect(parsed.revocation.target).toBe(other);
    expect(parsed.revocation.kid).toBe(kid);
  });

  it("**記録の署名を失効に使い回せない** (署名対象に経路が入る)", async () => {
    const pair = await generateSigningKeyPair();
    const kid = await kidOf(await exportPublicKey(pair.publicKey));
    const ingest = new URL(
      await buildIngestUrl(
        ORIGIN,
        {
          uid: UID,
          kid,
          time: TIME,
          entries: [
            {
              ph: PH_ALL,
              day: "2026-09-14",
              wbits: bitmapOf([]),
              rbits: bitmapOf([]),
              pages: 0,
              created: 0,
            },
          ],
        },
        (input) => sign(pair.privateKey, input),
      ),
    );
    const { url } = await revokeUrl();

    const parsed = parseRevokeQuery(url.searchParams);
    if (!parsed.ok) {
      throw new Error("読めなかった");
    }
    const stolen = ingest.searchParams.get("sig") ?? "";
    const forged = parseRevokeQuery(withParam(url, REVOKE_PARAM.signature, stolen));
    if (!forged.ok) {
      throw new Error("読めなかった");
    }
    expect(
      await verify(pair.publicKey, forged.revocation.signature, forged.revocation.signingInput),
    ).toBe(false);
  });
});

describe("形の検査", () => {
  it("キーが足りない・多いと keys", async () => {
    const { url } = await revokeUrl();
    const missing = new URLSearchParams(url.search);
    missing.delete(REVOKE_PARAM.target);
    expect(parseRevokeQuery(missing)).toEqual({ ok: false, reason: "keys" });

    const extra = new URLSearchParams(url.search);
    extra.set("zzz", "1");
    expect(parseRevokeQuery(extra)).toEqual({ ok: false, reason: "keys" });
  });

  it.each([
    [REVOKE_PARAM.version, "2", "version"],
    [REVOKE_PARAM.uid, "short", "uid"],
    [REVOKE_PARAM.kid, "xyz", "kid"],
    [REVOKE_PARAM.target, "xyz", "target"],
    [REVOKE_PARAM.time, "0", "time"],
    [REVOKE_PARAM.time, "-1", "time"],
    [REVOKE_PARAM.signature, "AAAA", "signature"],
  ])("%s が %s なら %s", async (key, value, reason) => {
    const { url } = await revokeUrl();
    expect(parseRevokeQuery(withParam(url, key, value))).toEqual({ ok: false, reason });
  });
});

describe("応答の幅", () => {
  it("消した / もう無かったを幅で返す", () => {
    expect(revokeWidth({ removed: false })).toBe(REVOKE_WIDTH_BASE);
    expect(revokeWidth({ removed: true })).toBe(REVOKE_WIDTH_BASE + 1);
    expect(readRevokeWidth(REVOKE_WIDTH_BASE)).toEqual({ removed: false });
    expect(readRevokeWidth(REVOKE_WIDTH_BASE + 1)).toEqual({ removed: true });
  });

  it.each([1, REVOKE_WIDTH_BASE - 1, REVOKE_WIDTH_BASE + 2, 1.5])(
    "**取り決めの外の幅 (%s) は undefined** (途中の何かが返した画像を成功にしない)",
    (width) => {
      expect(readRevokeWidth(width)).toBeUndefined();
    },
  );
});

describe("リプレイ窓", () => {
  it("**破壊的な操作なので記録 (300 秒) より狭い**", () => {
    expect(REVOKE_WINDOW_SECONDS).toBe(60);
  });
});
