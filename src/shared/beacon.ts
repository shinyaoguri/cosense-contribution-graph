/**
 * 記録の受け口 `GET /v1/p.gif` の取り決め (design §6)。UserScript が組み立て、Worker が読む。
 *
 * ```
 * /v1/p.gif?v=1&u=<uid>&d=<kid>&t=<unix秒>&p=<ph>|<day>|<wbits>|<rbits>|<pages>|<created>;...&sig=<base64url>
 * ```
 *
 * **形は厳密に読む。** キーは過不足も重複も許さず、値はすべて先頭と末尾を固定した形で照合する。
 * どのフィールドの文字集合にも `|` `;` 改行が無いので、区切りで分けた後の照合で曖昧さが残らない。
 * 時刻の窓や日付の窓のように「今」に依るものはここで見ない (Worker が見る)。
 *
 * 両 lib で型検査され、両環境でテストされる。
 */
import { decodeBase64url, encodeBase64url } from "./base64url.ts";
import { BITMAP_BYTES, type Bitmap, isBitmap } from "./bits.ts";
import { fromEpochDay, toEpochDay } from "./graph.ts";
import { isValidKid, isValidPh, isValidUid } from "./ids.ts";
import { SIGNATURE_BYTES, signingInput } from "./sign.ts";

export const INGEST_PATH = "/v1/p.gif";

const INGEST_VERSION = "1";

/** クエリの名前。 */
export const INGEST_PARAM = {
  version: "v",
  uid: "u",
  kid: "d",
  time: "t",
  entries: "p",
  signature: "sig",
} as const;

/**
 * 1 リクエストのエントリ (ph, day) の上限 (design §6)。
 * URL は 1 エントリ約 520 文字なので、14 件で約 7.3KB。Cloudflare の上限 16KB に収まる。
 */
export const MAX_ENTRIES = 14;

/** `pages` と `created` の上限。1 日にこれを超えるページを数えることは無い。 */
const MAX_COUNT = 99_999;

/** 1 つのプロジェクト (または合算 `*`) の 1 日分。 */
export type Entry = {
  readonly ph: string;
  readonly day: string;
  readonly wbits: Bitmap;
  readonly rbits: Bitmap;
  readonly pages: number;
  readonly created: number;
};

/** 署名される中身。 */
export type BeaconFields = {
  readonly uid: string;
  readonly kid: string;
  /** unix 秒 */
  readonly time: number;
  readonly entries: readonly Entry[];
};

type Beacon = BeaconFields & {
  readonly signature: Uint8Array<ArrayBuffer>;
  /** 検証に使う署名対象 (`sign.ts` の正規化) */
  readonly signingInput: string;
};

/** 拒否した理由。ログに出す (値そのものは出さない)。 */
type BeaconError = "keys" | "version" | "uid" | "kid" | "time" | "entries" | "signature";

export type ParseResult =
  | { readonly ok: true; readonly beacon: Beacon }
  | { readonly ok: false; readonly reason: BeaconError };

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BITMAP_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${(BITMAP_BYTES * 4) / 3}}$`);
const COUNT_PATTERN = /^(0|[1-9]\d{0,4})$/;
// unix 秒。先頭の 0 を許すと同じ時刻に別の表記ができる
const TIME_PATTERN = /^[1-9]\d{0,10}$/;

const ENTRY_SEPARATOR = ";";
const FIELD_SEPARATOR = "|";
const FIELD_COUNT = 6;

/** `YYYY-MM-DD` として実在する日か。2026-02-30 のように形だけ合う日を弾く。 */
function isValidDay(day: string): boolean {
  return DAY_PATTERN.test(day) && fromEpochDay(toEpochDay(day)) === day;
}

function isValidCount(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= MAX_COUNT;
}

/** `p` の値を組み立てる。形が取り決めの外なら RangeError (送る側の誤りなので黙って送らない)。 */
export function formatEntries(entries: readonly Entry[]): string {
  if (entries.length === 0 || entries.length > MAX_ENTRIES) {
    throw new RangeError(`エントリは 1〜${MAX_ENTRIES} 件: ${entries.length}`);
  }
  const seen = new Set<string>();
  return entries
    .map((entry) => {
      const key = `${entry.ph} ${entry.day}`;
      if (
        !isValidPh(entry.ph) ||
        !isValidDay(entry.day) ||
        !isBitmap(entry.wbits) ||
        !isBitmap(entry.rbits) ||
        !isValidCount(entry.pages) ||
        !isValidCount(entry.created) ||
        seen.has(key)
      ) {
        throw new RangeError(`エントリの形が取り決めの外: ${entry.ph} ${entry.day}`);
      }
      seen.add(key);
      return [
        entry.ph,
        entry.day,
        encodeBase64url(entry.wbits),
        encodeBase64url(entry.rbits),
        String(entry.pages),
        String(entry.created),
      ].join(FIELD_SEPARATOR);
    })
    .join(ENTRY_SEPARATOR);
}

/** `p` の値を読む。形が取り決めの外なら `undefined`。 */
export function parseEntries(raw: string): Entry[] | undefined {
  const parts = raw.split(ENTRY_SEPARATOR);
  if (parts.length > MAX_ENTRIES) {
    return undefined;
  }

  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    // 空のエントリ (`;;` や末尾の `;`、空の p) はフィールド数で落ちる
    const fields = part.split(FIELD_SEPARATOR);
    if (fields.length !== FIELD_COUNT) {
      return undefined;
    }
    const [ph = "", day = "", w = "", r = "", pages = "", created = ""] = fields;
    if (
      !isValidPh(ph) ||
      !isValidDay(day) ||
      !BITMAP_PATTERN.test(w) ||
      !BITMAP_PATTERN.test(r) ||
      !COUNT_PATTERN.test(pages) ||
      !COUNT_PATTERN.test(created)
    ) {
      return undefined;
    }
    const wbits = decodeBase64url(w);
    const rbits = decodeBase64url(r);
    const key = `${ph} ${day}`;
    if (!wbits || !rbits || !isBitmap(wbits) || !isBitmap(rbits) || seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    entries.push({ ph, day, wbits, rbits, pages: Number(pages), created: Number(created) });
  }
  return entries;
}

function signedFields(
  fields: Pick<BeaconFields, "uid" | "kid" | "time">,
  entries: string,
): [string, string][] {
  return [
    [INGEST_PARAM.version, INGEST_VERSION],
    [INGEST_PARAM.uid, fields.uid],
    [INGEST_PARAM.kid, fields.kid],
    [INGEST_PARAM.time, String(fields.time)],
    [INGEST_PARAM.entries, entries],
  ];
}

const EXPECTED_KEYS: readonly string[] = Object.values(INGEST_PARAM);

/**
 * 受け口のクエリを読む。署名の**検証はしない** (鍵を引くのは Worker)。
 *
 * **署名が 64 バイトでなければここで拒否する。** DER を渡されたときに verify が静かに `false` を返し、
 * 「署名が違う」(403) と取り違えるのを防ぐ (ADR-0009)。
 */
export function parseIngestQuery(search: URLSearchParams): ParseResult {
  const keys = [...search.keys()];
  if (keys.length !== EXPECTED_KEYS.length || EXPECTED_KEYS.some((key) => !keys.includes(key))) {
    return { ok: false, reason: "keys" };
  }

  const get = (key: string) => search.get(key) ?? "";
  if (get(INGEST_PARAM.version) !== INGEST_VERSION) {
    return { ok: false, reason: "version" };
  }
  const uid = get(INGEST_PARAM.uid);
  if (!isValidUid(uid)) {
    return { ok: false, reason: "uid" };
  }
  const kid = get(INGEST_PARAM.kid);
  if (!isValidKid(kid)) {
    return { ok: false, reason: "kid" };
  }
  const rawTime = get(INGEST_PARAM.time);
  if (!TIME_PATTERN.test(rawTime)) {
    return { ok: false, reason: "time" };
  }
  const rawEntries = get(INGEST_PARAM.entries);
  const entries = parseEntries(rawEntries);
  if (!entries) {
    return { ok: false, reason: "entries" };
  }
  const signature = decodeBase64url(get(INGEST_PARAM.signature));
  if (signature?.length !== SIGNATURE_BYTES) {
    return { ok: false, reason: "signature" };
  }

  const time = Number(rawTime);
  return {
    ok: true,
    beacon: {
      uid,
      kid,
      time,
      entries,
      signature,
      signingInput: signingInput(INGEST_PATH, signedFields({ uid, kid, time }, rawEntries)),
    },
  };
}

/**
 * 受け口の URL を組み立てる。署名は `signer` に任せる (UserScript は IndexedDB の鍵で、テストは生成した鍵で署名する)。
 * 値は生のまま署名し、URL に乗せるときだけエンコードする。
 */
export async function buildIngestUrl(
  origin: string,
  fields: BeaconFields,
  signer: (input: string) => Promise<Uint8Array<ArrayBuffer>>,
): Promise<string> {
  const entries = formatEntries(fields.entries);
  const pairs = signedFields(fields, entries);
  const signature = await signer(signingInput(INGEST_PATH, pairs));
  if (signature.length !== SIGNATURE_BYTES) {
    throw new RangeError(`署名は ${SIGNATURE_BYTES} バイト: ${signature.length}`);
  }

  const url = new URL(INGEST_PATH, origin);
  for (const [key, value] of pairs) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set(INGEST_PARAM.signature, encodeBase64url(signature));
  return url.href;
}

/**
 * 応答の GIF の幅 = これ + ビットの和 (16〜17)。
 * 16 から始めるのは、途中の何かが返した 1×1 の画像を「届いた」と取り違えないため (`/v1/probe.gif` と同じ)。
 */
export const INGEST_WIDTH_BASE = 16;

/** Worker が記録した結果。 */
export type IngestOutcome = {
  /** D1 に書いた。**同じ中身を 2 回送ると 2 回目は `false`** (冪等) */
  readonly written: boolean;
};

const WRITTEN_BIT = 1;

export function ingestWidth(outcome: IngestOutcome): number {
  return INGEST_WIDTH_BASE + (outcome.written ? WRITTEN_BIT : 0);
}

/** 幅から結果を読む。取り決めの範囲 (16〜17) の外なら `undefined`。 */
export function readIngestWidth(width: number): IngestOutcome | undefined {
  const bits = width - INGEST_WIDTH_BASE;
  if (!Number.isInteger(bits) || bits < 0 || bits > WRITTEN_BIT) {
    return undefined;
  }
  return { written: (bits & WRITTEN_BIT) !== 0 };
}
