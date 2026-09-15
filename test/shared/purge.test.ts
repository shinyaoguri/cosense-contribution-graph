import { describe, expect, it } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { kidOf, UID_BYTES } from "../../src/shared/ids.ts";
import {
  buildPurgeUrl,
  PURGE_PARAM,
  PURGE_PATH,
  PURGE_WIDTH_BASE,
  PURGE_WINDOW_SECONDS,
  parsePurgeQuery,
  purgeWidth,
  readPurgeWidth,
} from "../../src/shared/purge.ts";
import { buildRevokeUrl, REVOKE_PARAM } from "../../src/shared/revoke.ts";
import {
  exportPublicKey,
  generateSigningKeyPair,
  SIGNATURE_BYTES,
  sign,
  verify,
} from "../../src/shared/sign.ts";

// UserScript が組み立てた URL を Worker が同じ中身・同じ署名対象に読むことが前提。両環境で走らせる

const ORIGIN = "https://example.com";
const UID = encodeBase64url(new Uint8Array(UID_BYTES).fill(2));
const TIME = 1_789_000_000;

async function purgeUrl(overrides: Partial<{ uid: string; time: number }> = {}) {
  const pair = await generateSigningKeyPair();
  const kid = await kidOf(await exportPublicKey(pair.publicKey));
  const href = await buildPurgeUrl(
    ORIGIN,
    { uid: overrides.uid ?? UID, kid, time: overrides.time ?? TIME },
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
    const { url, pair, kid } = await purgeUrl();

    expect(url.pathname).toBe(PURGE_PATH);
    expect(url.searchParams.get(PURGE_PARAM.confirm)).toBe("1");
    const parsed = parsePurgeQuery(url.searchParams);
    if (!parsed.ok) {
      throw new Error(`読めなかった: ${parsed.reason}`);
    }
    expect(parsed.purge).toMatchObject({ uid: UID, kid, time: TIME });
    expect(parsed.purge.signature).toHaveLength(SIGNATURE_BYTES);
    expect(await verify(pair.publicKey, parsed.purge.signature, parsed.purge.signingInput)).toBe(
      true,
    );
  });

  it("**失効の署名を削除に使い回せない** (署名対象に経路が入る)", async () => {
    const pair = await generateSigningKeyPair();
    const kid = await kidOf(await exportPublicKey(pair.publicKey));
    const revoke = new URL(
      await buildRevokeUrl(ORIGIN, { uid: UID, kid, target: kid, time: TIME }, (input) =>
        sign(pair.privateKey, input),
      ),
    );
    const { url } = await purgeUrl();

    const stolen = revoke.searchParams.get(REVOKE_PARAM.signature) ?? "";
    const forged = parsePurgeQuery(withParam(url, PURGE_PARAM.signature, stolen));
    if (!forged.ok) {
      throw new Error("読めなかった");
    }
    expect(await verify(pair.publicKey, forged.purge.signature, forged.purge.signingInput)).toBe(
      false,
    );
  });
});

describe("形の検査", () => {
  it("キーが足りない・多いと keys", async () => {
    const { url } = await purgeUrl();
    const missing = new URLSearchParams(url.search);
    missing.delete(PURGE_PARAM.confirm);
    expect(parsePurgeQuery(missing)).toEqual({ ok: false, reason: "keys" });

    const extra = new URLSearchParams(url.search);
    extra.set("zzz", "1");
    expect(parsePurgeQuery(extra)).toEqual({ ok: false, reason: "keys" });
  });

  it.each([
    [PURGE_PARAM.version, "2", "version"],
    [PURGE_PARAM.uid, "short", "uid"],
    [PURGE_PARAM.kid, "xyz", "kid"],
    [PURGE_PARAM.confirm, "0", "confirm"],
    [PURGE_PARAM.confirm, "true", "confirm"],
    [PURGE_PARAM.time, "0", "time"],
    [PURGE_PARAM.signature, "AAAA", "signature"],
  ])("%s が %s なら %s", async (key, value, reason) => {
    const { url } = await purgeUrl();
    expect(parsePurgeQuery(withParam(url, key, value))).toEqual({ ok: false, reason });
  });
});

describe("応答の幅", () => {
  it("消した / 何も無かったを幅で返す", () => {
    expect(purgeWidth({ deleted: false })).toBe(PURGE_WIDTH_BASE);
    expect(purgeWidth({ deleted: true })).toBe(PURGE_WIDTH_BASE + 1);
    expect(readPurgeWidth(PURGE_WIDTH_BASE)).toEqual({ deleted: false });
    expect(readPurgeWidth(PURGE_WIDTH_BASE + 1)).toEqual({ deleted: true });
  });

  it.each([1, PURGE_WIDTH_BASE - 1, PURGE_WIDTH_BASE + 2])(
    "**取り決めの外の幅 (%s) は undefined**",
    (width) => {
      expect(readPurgeWidth(width)).toBeUndefined();
    },
  );
});

describe("リプレイ窓", () => {
  it("**破壊的な操作なので記録 (300 秒) より狭い**", () => {
    expect(PURGE_WINDOW_SECONDS).toBe(60);
  });
});
