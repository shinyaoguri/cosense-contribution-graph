import { describe, expect, it } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import {
  type BeaconFields,
  buildIngestUrl,
  type Entry,
  formatEntries,
  INGEST_PARAM,
  INGEST_PATH,
  INGEST_WIDTH_BASE,
  ingestWidth,
  MAX_ENTRIES,
  parseEntries,
  parseIngestQuery,
  readIngestWidth,
} from "../../src/shared/beacon.ts";
import { bitmapOf, bitsEqual } from "../../src/shared/bits.ts";
import { PH_ALL, UID_BYTES } from "../../src/shared/ids.ts";
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
const KID = "0123456789abcdef";
const PH = "fedcba9876543210";
const TIME = 1_789_358_609;

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    ph: PH_ALL,
    day: "2026-09-14",
    wbits: bitmapOf([0, 1, 2]),
    rbits: bitmapOf([2, 3, 4, 5]),
    pages: 3,
    created: 1,
    ...overrides,
  };
}

function fields(entries: readonly Entry[] = [entry()]): BeaconFields {
  return { uid: UID, kid: KID, time: TIME, entries };
}

/** 署名だけ偽物 (64 バイトの 0) で URL を作る。形の検査を見るテスト用。 */
function buildUnsigned(beacon: BeaconFields = fields()): Promise<string> {
  return buildIngestUrl(ORIGIN, beacon, async () => new Uint8Array(64));
}

async function searchOf(beacon: BeaconFields = fields()): Promise<URLSearchParams> {
  return new URL(await buildUnsigned(beacon)).searchParams;
}

describe("エントリ p の往復", () => {
  it("組み立てて読むと同じ中身に戻る", () => {
    const original = [entry(), entry({ ph: PH, day: "2026-09-13", pages: 0, created: 0 })];
    const parsed = parseEntries(formatEntries(original));

    expect(parsed).toHaveLength(2);
    for (const [i, e] of original.entries()) {
      const p = parsed?.[i];
      expect(p?.ph).toBe(e.ph);
      expect(p?.day).toBe(e.day);
      expect(p?.pages).toBe(e.pages);
      expect(p?.created).toBe(e.created);
      expect(p && bitsEqual(p.wbits, e.wbits)).toBe(true);
      expect(p && bitsEqual(p.rbits, e.rbits)).toBe(true);
    }
  });

  it("1 エントリは ph|day|wbits|rbits|pages|created で、ビットマップは 240 文字", () => {
    const [ph, day, w, r, pages, created] = formatEntries([entry()]).split("|");
    expect([ph, day, pages, created]).toEqual(["*", "2026-09-14", "3", "1"]);
    expect(w).toHaveLength(240);
    expect(r).toHaveLength(240);
  });

  it(`${MAX_ENTRIES} 件までは読み、${MAX_ENTRIES + 1} 件は拒否する`, () => {
    const days = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        entry({ day: `2026-09-${String(i + 1).padStart(2, "0")}` }),
      );
    expect(parseEntries(formatEntries(days(MAX_ENTRIES)))).toHaveLength(MAX_ENTRIES);

    const raw = `${formatEntries(days(MAX_ENTRIES))};${formatEntries([entry({ day: "2026-09-30" })])}`;
    expect(parseEntries(raw)).toBeUndefined();
  });

  describe("形が取り決めの外なら読まない", () => {
    const valid = formatEntries([entry()]);
    const fieldsOf = () => valid.split("|");
    const withField = (index: number, value: string) =>
      fieldsOf()
        .map((f, i) => (i === index ? value : f))
        .join("|");

    it("空・`;;`・末尾の `;`", () => {
      expect(parseEntries("")).toBeUndefined();
      expect(parseEntries(`${valid};;${formatEntries([entry({ ph: PH })])}`)).toBeUndefined();
      expect(parseEntries(`${valid};`)).toBeUndefined();
    });

    it("フィールドの過不足", () => {
      expect(parseEntries(`${valid}|0`)).toBeUndefined();
      expect(parseEntries(fieldsOf().slice(0, 5).join("|"))).toBeUndefined();
    });

    it("不正な ph (大文字・12 桁・空)", () => {
      expect(parseEntries(withField(0, "FEDCBA9876543210"))).toBeUndefined();
      expect(parseEntries(withField(0, "fedcba987654"))).toBeUndefined();
      expect(parseEntries(withField(0, ""))).toBeUndefined();
    });

    it("実在しない日と形の違う日", () => {
      expect(parseEntries(withField(1, "2026-02-30"))).toBeUndefined();
      expect(parseEntries(withField(1, "2026-9-14"))).toBeUndefined();
      expect(parseEntries(withField(1, "0050-01-01"))).toBeUndefined();
    });

    it("ビットマップの長さ違いと、base64url でない文字", () => {
      expect(parseEntries(withField(2, "A".repeat(239)))).toBeUndefined();
      expect(parseEntries(withField(3, "A".repeat(244)))).toBeUndefined();
      expect(parseEntries(withField(2, `${"A".repeat(239)}+`))).toBeUndefined();
    });

    it("先頭の 0・負数・上限超えの pages と created", () => {
      expect(parseEntries(withField(4, "03"))).toBeUndefined();
      expect(parseEntries(withField(4, "-1"))).toBeUndefined();
      expect(parseEntries(withField(5, "100000"))).toBeUndefined();
      expect(parseEntries(withField(5, "99999"))).toHaveLength(1);
    });

    it("同じ (ph, day) の重複", () => {
      expect(parseEntries(`${valid};${valid}`)).toBeUndefined();
    });
  });

  it("組み立てる側も取り決めの外を RangeError にする (黙って送らない)", () => {
    expect(() => formatEntries([])).toThrow(RangeError);
    expect(() => formatEntries([entry({ ph: "X" })])).toThrow(RangeError);
    expect(() => formatEntries([entry({ day: "2026-02-30" })])).toThrow(RangeError);
    expect(() => formatEntries([entry({ wbits: new Uint8Array(179) })])).toThrow(RangeError);
    expect(() => formatEntries([entry({ pages: -1 })])).toThrow(RangeError);
    expect(() => formatEntries([entry(), entry()])).toThrow(RangeError);
  });
});

describe("受け口の URL", () => {
  it(`経路は ${INGEST_PATH} で、キーは v・u・d・t・p・sig`, async () => {
    const url = new URL(await buildUnsigned());
    expect(url.pathname).toBe("/v1/p.gif");
    expect([...url.searchParams.keys()].sort()).toEqual(["d", "p", "sig", "t", "u", "v"]);
  });

  it("**組み立てた URL を読むと、署名した文字列と同じ署名対象が得られる**", async () => {
    let signed = "";
    const url = await buildIngestUrl(
      ORIGIN,
      fields([entry(), entry({ ph: PH })]),
      async (input) => {
        signed = input;
        return new Uint8Array(64);
      },
    );
    const result = parseIngestQuery(new URL(url).searchParams);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.beacon.signingInput).toBe(signed);
    expect(signed.split("\n")[0]).toBe("/v1/p.gif");
    expect(signed).toContain(`\nu=${UID}\nd=${KID}\nt=${TIME}\np=*|2026-09-14|`);
    expect(result.beacon.uid).toBe(UID);
    expect(result.beacon.kid).toBe(KID);
    expect(result.beacon.time).toBe(TIME);
    expect(result.beacon.entries).toHaveLength(2);
  });

  it("**生成した鍵で署名した URL は、読んだ署名対象で verify が通る** (両端の往復)", async () => {
    const pair = await generateSigningKeyPair();
    const url = await buildIngestUrl(ORIGIN, fields(), (input) => sign(pair.privateKey, input));
    const result = parseIngestQuery(new URL(url).searchParams);
    if (!result.ok) throw new Error(result.reason);

    const key = await importVerifyKey(await exportPublicKey(pair.publicKey));
    expect(await verify(key, result.beacon.signature, result.beacon.signingInput)).toBe(true);
  });

  it("64 バイトでない署名を返す signer は RangeError", async () => {
    await expect(buildIngestUrl(ORIGIN, fields(), async () => new Uint8Array(71))).rejects.toThrow(
      RangeError,
    );
  });

  describe("読む側は形が取り決めの外なら理由を返す", () => {
    async function reasonOf(edit: (search: URLSearchParams) => void) {
      const search = await searchOf();
      edit(search);
      const result = parseIngestQuery(search);
      return result.ok ? "ok" : result.reason;
    }

    it("何も変えなければ通る", async () => {
      expect(await reasonOf(() => {})).toBe("ok");
    });

    it("キーの欠け・未知のキー・**重複キー**", async () => {
      expect(await reasonOf((s) => s.delete(INGEST_PARAM.time))).toBe("keys");
      expect(await reasonOf((s) => s.append("x", "1"))).toBe("keys");
      expect(await reasonOf((s) => s.append(INGEST_PARAM.uid, UID))).toBe("keys");
    });

    it("版の違い", async () => {
      expect(await reasonOf((s) => s.set(INGEST_PARAM.version, "2"))).toBe("version");
    });

    it("uid の長さ違いと非正規な表記", async () => {
      expect(await reasonOf((s) => s.set(INGEST_PARAM.uid, UID.slice(1)))).toBe("uid");
      expect(await reasonOf((s) => s.set(INGEST_PARAM.uid, `${UID.slice(0, 26)}B`))).toBe("uid");
    });

    it("kid の大文字と長さ違い", async () => {
      expect(await reasonOf((s) => s.set(INGEST_PARAM.kid, KID.toUpperCase()))).toBe("kid");
      expect(await reasonOf((s) => s.set(INGEST_PARAM.kid, KID.slice(1)))).toBe("kid");
    });

    it("時刻の先頭の 0・小数・負数", async () => {
      expect(await reasonOf((s) => s.set(INGEST_PARAM.time, `0${TIME}`))).toBe("time");
      expect(await reasonOf((s) => s.set(INGEST_PARAM.time, `${TIME}.5`))).toBe("time");
      expect(await reasonOf((s) => s.set(INGEST_PARAM.time, `-${TIME}`))).toBe("time");
    });

    it("エントリの形", async () => {
      expect(await reasonOf((s) => s.set(INGEST_PARAM.entries, ""))).toBe("entries");
    });

    it("**署名が 64 バイトでない (DER の長さを含む)・非正規な表記**", async () => {
      const sig = (n: number) => encodeBase64url(new Uint8Array(n));
      expect(await reasonOf((s) => s.set(INGEST_PARAM.signature, sig(63)))).toBe("signature");
      expect(await reasonOf((s) => s.set(INGEST_PARAM.signature, sig(65)))).toBe("signature");
      expect(await reasonOf((s) => s.set(INGEST_PARAM.signature, sig(71)))).toBe("signature");
      // 64 バイトは 86 文字で、末尾の下位 4 bit が余る。"A" の代わりに "B" は非正規
      expect(await reasonOf((s) => s.set(INGEST_PARAM.signature, `${sig(64).slice(0, 85)}B`))).toBe(
        "signature",
      );
    });
  });
});

describe("応答の幅", () => {
  it("書いたら 17、変化なしなら 16", () => {
    expect(INGEST_WIDTH_BASE).toBe(16);
    expect(ingestWidth({ written: true })).toBe(17);
    expect(ingestWidth({ written: false })).toBe(16);
  });

  it("往復する", () => {
    expect(readIngestWidth(17)).toEqual({ written: true });
    expect(readIngestWidth(16)).toEqual({ written: false });
  });

  it("**1×1 の画像や取り決めの外の幅は結果として読まない**", () => {
    expect(readIngestWidth(1)).toBeUndefined();
    expect(readIngestWidth(15)).toBeUndefined();
    expect(readIngestWidth(18)).toBeUndefined();
    expect(readIngestWidth(16.5)).toBeUndefined();
  });
});
