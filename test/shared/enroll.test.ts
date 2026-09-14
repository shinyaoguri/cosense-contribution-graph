import { describe, expect, it } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { buildIngestUrl } from "../../src/shared/beacon.ts";
import { bitmapOf } from "../../src/shared/bits.ts";
import {
  buildEnrollUrl,
  ENROLL_PARAM,
  ENROLL_PATH,
  ENROLL_TOKEN_BYTES,
  ENROLL_WIDTH_BASE,
  enrollWidth,
  isValidEnrollToken,
  parseEnrollQuery,
  readEnrollWidth,
} from "../../src/shared/enroll.ts";
import { kidOf, PH_ALL, UID_BYTES } from "../../src/shared/ids.ts";
import {
  exportPublicKey,
  generateSigningKeyPair,
  importVerifyKey,
  sign,
  verify,
} from "../../src/shared/sign.ts";

// UserScript が組み立てた URL を Worker が同じ中身・同じ署名対象に読むことが前提。両環境で走らせる

const ORIGIN = "https://example.com";
const UID = encodeBase64url(new Uint8Array(UID_BYTES).fill(1));
const TOKEN = encodeBase64url(new Uint8Array(ENROLL_TOKEN_BYTES).fill(7));

async function enrollUrl(overrides: Partial<{ uid: string; token: string }> = {}) {
  const pair = await generateSigningKeyPair();
  const publicKey = await exportPublicKey(pair.publicKey);
  const href = await buildEnrollUrl(
    ORIGIN,
    { uid: overrides.uid ?? UID, publicKey, token: overrides.token ?? TOKEN },
    (input) => sign(pair.privateKey, input),
  );
  return { url: new URL(href), pair, publicKey };
}

function withParam(url: URL, key: string, value: string): URLSearchParams {
  const search = new URLSearchParams(url.search);
  search.set(key, value);
  return search;
}

describe("buildEnrollUrl と parseEnrollQuery", () => {
  it("組み立てた URL を同じ中身に読み、その鍵で署名を検証できる", async () => {
    const { url, publicKey } = await enrollUrl();
    expect(url.pathname).toBe(ENROLL_PATH);

    const parsed = parseEnrollQuery(url.searchParams);
    if (!parsed.ok) {
      throw new Error(parsed.reason);
    }
    const { enrollment } = parsed;
    expect(enrollment.uid).toBe(UID);
    expect([...enrollment.publicKey]).toEqual([...publicKey]);
    expect(enrollment.token).toBe(TOKEN);
    expect(
      await verify(
        await importVerifyKey(enrollment.publicKey),
        enrollment.signature,
        enrollment.signingInput,
      ),
    ).toBe(true);
  });

  it("**署名対象の先頭は経路で、登録する公開鍵とトークンを含む**", async () => {
    const { url } = await enrollUrl();
    const parsed = parseEnrollQuery(url.searchParams);
    expect(parsed.ok && parsed.enrollment.signingInput).toBe(
      `/v1/enroll.gif\nv=1\nu=${UID}\nk=${url.searchParams.get("k")}\ntok=${TOKEN}`,
    );
  });

  it("**/v1/p.gif の署名は登録に使えない** (署名対象が違う)", async () => {
    const pair = await generateSigningKeyPair();
    const publicKey = await exportPublicKey(pair.publicKey);
    const ingest = new URL(
      await buildIngestUrl(
        ORIGIN,
        {
          uid: UID,
          kid: await kidOf(publicKey),
          time: 1_789_358_609,
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
    const { url } = await enrollUrl();
    const search = withParam(url, ENROLL_PARAM.publicKey, encodeBase64url(publicKey));
    search.set(ENROLL_PARAM.signature, ingest.searchParams.get("sig") ?? "");

    const parsed = parseEnrollQuery(search);
    if (!parsed.ok) {
      throw new Error(parsed.reason);
    }
    expect(
      await verify(pair.publicKey, parsed.enrollment.signature, parsed.enrollment.signingInput),
    ).toBe(false);
  });

  it("キーの過不足・重複・未知のキーは keys", async () => {
    const { url } = await enrollUrl();
    const missing = new URLSearchParams(url.search);
    missing.delete(ENROLL_PARAM.token);
    const duplicated = new URLSearchParams(url.search);
    duplicated.append(ENROLL_PARAM.token, TOKEN);
    const unknown = new URLSearchParams(url.search);
    unknown.delete(ENROLL_PARAM.version);
    unknown.set("t", "1");

    for (const search of [missing, duplicated, unknown]) {
      expect(parseEnrollQuery(search)).toEqual({ ok: false, reason: "keys" });
    }
  });

  it.each([
    ["v が 2", ENROLL_PARAM.version, "2", "version"],
    ["uid が 26 文字", ENROLL_PARAM.uid, UID.slice(0, 26), "uid"],
    [
      "公開鍵が 64 バイト",
      ENROLL_PARAM.publicKey,
      encodeBase64url(new Uint8Array(64).fill(4)),
      "key",
    ],
    [
      "公開鍵がパディングつき",
      ENROLL_PARAM.publicKey,
      `${encodeBase64url(new Uint8Array(65).fill(4))}=`,
      "key",
    ],
    ["トークンが 21 文字", ENROLL_PARAM.token, TOKEN.slice(0, 21), "token"],
    ["トークンの余りビットが立っている", ENROLL_PARAM.token, `${TOKEN.slice(0, 21)}B`, "token"],
    [
      "署名が DER の長さ (70 バイト)",
      ENROLL_PARAM.signature,
      encodeBase64url(new Uint8Array(70)),
      "signature",
    ],
  ])("%s なら %s", async (_, key, value, reason) => {
    const { url } = await enrollUrl();
    expect(parseEnrollQuery(withParam(url, key, value))).toEqual({ ok: false, reason });
  });

  it("取り決めの外の中身は組み立てない", async () => {
    await expect(enrollUrl({ uid: "short" })).rejects.toThrow(RangeError);
    await expect(enrollUrl({ token: "short" })).rejects.toThrow(RangeError);
  });

  it("isValidEnrollToken は 16 バイトの正規な base64url だけ", () => {
    expect(isValidEnrollToken(TOKEN)).toBe(true);
    expect(TOKEN).toHaveLength(22);
    expect(isValidEnrollToken(`${TOKEN}A`)).toBe(false);
    expect(isValidEnrollToken("")).toBe(false);
  });
});

describe("応答の幅", () => {
  it("新しく登録したら 17、登録済みなら 16。読むと元に戻る", () => {
    expect(enrollWidth({ added: true })).toBe(17);
    expect(enrollWidth({ added: false })).toBe(ENROLL_WIDTH_BASE);
    expect(readEnrollWidth(17)).toEqual({ added: true });
    expect(readEnrollWidth(16)).toEqual({ added: false });
  });

  it("**1×1 の画像は結果として読まない**", () => {
    for (const width of [1, 15, 18, 16.5]) {
      expect(readEnrollWidth(width)).toBeUndefined();
    }
  });
});
