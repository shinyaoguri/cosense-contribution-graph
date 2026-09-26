/**
 * 記録の受け口 `GET /v1/p.gif` の取り決め (design §6)。UserScript が組み立て、Worker が読む。
 *
 * ```
 * /v1/p.gif?v=2&u=<uid>&d=<kid>&t=<unix秒>&p=<ph>.<day>.<wbits>.<rbits>.<pages>.<created>.<wc>.<wo>.<links>&p=...&sig=<base64url>
 * ```
 *
 * **v2 (ADR-0021)** はエントリに作る・関わるの分 (`wc` / `wo`) とリンクの件数を足し、区切りを URL エンコードされない
 * `.` と `p` の繰り返しにした。**v1 (`|` と `;`、`p` は 1 つ) も読む。** 配布ページ `v1` を貼り替えるまでの移行のためで、
 * v1 のエントリは `wc` / `wo` / `links` を 0 として読む。組み立てるのは v2 だけ。
 *
 * **形は厳密に読む。** キーは過不足も (`p` 以外の) 重複も許さず、値はすべて先頭と末尾を固定した形で照合する。
 * どのフィールドの文字集合にも区切り (`.` `|` `;`) と改行が無いので、区切りで分けた後の照合で曖昧さが残らない。
 * 時刻の窓や日付の窓のように「今」に依るものはここで見ない (Worker が見る)。
 *
 * 両 lib で型検査され、両環境でテストされる。
 */
import { decodeBase64url, encodeBase64url } from "./base64url.ts";
import { BITMAP_BYTES, type Bitmap, isBitmap, MINUTES_PER_DAY, popcount } from "./bits.ts";
import { fromEpochDay, toEpochDay } from "./epoch-day.ts";
import { isValidKid, isValidPh, isValidUid } from "./ids.ts";
import { SIGNATURE_BYTES, signingInput } from "./sign.ts";

export const INGEST_PATH = "/v1/p.gif";

const INGEST_VERSION = "2";

/** 移行のために読むだけの版。配布ページ `v1` を貼り替えたら止める。 */
const LEGACY_VERSION = "1";

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
 * URL は 1 エントリ最大 529 文字 + 区切り 8 + `&p=` 3 なので、14 件で約 7.6KB。
 * Cloudflare の上限 16KB に収まる (UserScript の outbox のテストが 8,000 文字以下を固定している)。
 */
export const MAX_ENTRIES = 14;

/** `pages`・`created`・`links` の上限。1 日にこれを超える数を数えることは無い。 */
export const MAX_COUNT = 99_999;

/** 1 つのプロジェクト (または合算 `*`) の 1 日分。 */
export type Entry = {
  readonly ph: string;
  readonly day: string;
  readonly wbits: Bitmap;
  readonly rbits: Bitmap;
  readonly pages: number;
  readonly created: number;
  /** 作る (その日に自分が作ったページに書いた分)。ADR-0021 */
  readonly wc: number;
  /** 関わる (他の人が作ったページに書いた分) */
  readonly wo: number;
  /** 作ったリンクの件数 */
  readonly links: number;
};

/** 署名される中身。 */
export type BeaconFields = {
  readonly uid: string;
  readonly kid: string;
  /** unix 秒 */
  readonly time: number;
  readonly entries: readonly Entry[];
};

export type Beacon = BeaconFields & {
  readonly signature: Uint8Array<ArrayBuffer>;
  /** 検証に使う署名対象 (`sign.ts` の正規化) */
  readonly signingInput: string;
};

/** 拒否した理由。ログに出す (値そのものは出さない)。 */
export type BeaconError = "keys" | "version" | "uid" | "kid" | "time" | "entries" | "signature";

export type ParseResult =
  | { readonly ok: true; readonly beacon: Beacon }
  | { readonly ok: false; readonly reason: BeaconError };

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BITMAP_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${(BITMAP_BYTES * 4) / 3}}$`);
const COUNT_PATTERN = /^(0|[1-9]\d{0,4})$/;
// 分の数。上限 1440 は数値で見る
const MINUTES_PATTERN = /^(0|[1-9]\d{0,3})$/;
// unix 秒。先頭の 0 を許すと同じ時刻に別の表記ができる
const TIME_PATTERN = /^[1-9]\d{0,10}$/;

const FIELD_SEPARATOR = ".";
const FIELD_COUNT = 9;
const LEGACY_ENTRY_SEPARATOR = ";";
const LEGACY_FIELD_SEPARATOR = "|";
const LEGACY_FIELD_COUNT = 6;

/** `YYYY-MM-DD` として実在する日か。2026-02-30 のように形だけ合う日を弾く。 */
function isValidDay(day: string): boolean {
  return DAY_PATTERN.test(day) && fromEpochDay(toEpochDay(day)) === day;
}

function isValidCount(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= MAX_COUNT;
}

function isValidMinutes(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= MINUTES_PER_DAY;
}

/**
 * 作る・関わるの分が書いた分に収まるか。1 つの端末の `c` と `o` は `w` の部分集合で互いに重ならないので、
 * 正しいクライアントからは超えない (design §6)。
 */
function withinWrites(entry: Pick<Entry, "wbits" | "wc" | "wo">): boolean {
  return entry.wc + entry.wo <= popcount(entry.wbits);
}

/** 1 エントリの `p` の値 (v2) を組み立てる。形が取り決めの外なら RangeError (送る側の誤りなので黙って送らない)。 */
export function formatEntry(entry: Entry): string {
  if (
    !isValidPh(entry.ph) ||
    !isValidDay(entry.day) ||
    !isBitmap(entry.wbits) ||
    !isBitmap(entry.rbits) ||
    !isValidCount(entry.pages) ||
    !isValidCount(entry.created) ||
    !isValidMinutes(entry.wc) ||
    !isValidMinutes(entry.wo) ||
    !isValidCount(entry.links) ||
    !withinWrites(entry)
  ) {
    throw new RangeError(`エントリの形が取り決めの外: ${entry.ph} ${entry.day}`);
  }
  return [
    entry.ph,
    entry.day,
    encodeBase64url(entry.wbits),
    encodeBase64url(entry.rbits),
    String(entry.pages),
    String(entry.created),
    String(entry.wc),
    String(entry.wo),
    String(entry.links),
  ].join(FIELD_SEPARATOR);
}

/** `p` の値を組み立てる (1 エントリ 1 つ)。件数と (ph, day) の重複も見る。 */
export function formatEntries(entries: readonly Entry[]): string[] {
  if (entries.length === 0 || entries.length > MAX_ENTRIES) {
    throw new RangeError(`エントリは 1〜${MAX_ENTRIES} 件: ${entries.length}`);
  }
  const seen = new Set<string>();
  return entries.map((entry) => {
    const key = `${entry.ph} ${entry.day}`;
    if (seen.has(key)) {
      throw new RangeError(`エントリが重複している: ${entry.ph} ${entry.day}`);
    }
    seen.add(key);
    return formatEntry(entry);
  });
}

type Counts = Pick<Entry, "pages" | "created" | "wc" | "wo" | "links">;

/** ph・day・ビットマップ 2 つを読み、残りのフィールドは `counts` に任せる。 */
function parseFields(
  fields: readonly string[],
  counts: (rest: readonly string[]) => Counts | undefined,
): Entry | undefined {
  const [ph = "", day = "", w = "", r = "", ...rest] = fields;
  if (!isValidPh(ph) || !isValidDay(day) || !BITMAP_PATTERN.test(w) || !BITMAP_PATTERN.test(r)) {
    return undefined;
  }
  const wbits = decodeBase64url(w);
  const rbits = decodeBase64url(r);
  const parsed = counts(rest);
  if (!wbits || !rbits || !isBitmap(wbits) || !isBitmap(rbits) || !parsed) {
    return undefined;
  }
  const entry = { ph, day, wbits, rbits, ...parsed };
  return withinWrites(entry) ? entry : undefined;
}

/** 件数と (ph, day) の重複を見る。 */
function collect(
  parts: readonly string[],
  parse: (part: string) => Entry | undefined,
): Entry[] | undefined {
  if (parts.length === 0 || parts.length > MAX_ENTRIES) {
    return undefined;
  }
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const entry = parse(part);
    const key = entry && `${entry.ph} ${entry.day}`;
    if (!entry || !key || seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

/** v2 の `p` の値 (出現順) を読む。形が取り決めの外なら `undefined`。 */
export function parseEntries(raws: readonly string[]): Entry[] | undefined {
  return collect(raws, (raw) => {
    // 空の p や区切りの過不足はフィールド数で落ちる
    const fields = raw.split(FIELD_SEPARATOR);
    if (fields.length !== FIELD_COUNT) {
      return undefined;
    }
    return parseFields(fields, ([pages = "", created = "", wc = "", wo = "", links = ""]) => {
      if (
        !COUNT_PATTERN.test(pages) ||
        !COUNT_PATTERN.test(created) ||
        !MINUTES_PATTERN.test(wc) ||
        !MINUTES_PATTERN.test(wo) ||
        !COUNT_PATTERN.test(links) ||
        !isValidMinutes(Number(wc)) ||
        !isValidMinutes(Number(wo))
      ) {
        return undefined;
      }
      return {
        pages: Number(pages),
        created: Number(created),
        wc: Number(wc),
        wo: Number(wo),
        links: Number(links),
      };
    });
  });
}

/** v1 の `p` の値を読む (移行のため)。`wc` / `wo` / `links` は 0。 */
export function parseLegacyEntries(raw: string): Entry[] | undefined {
  // 空のエントリ (`;;` や末尾の `;`、空の p) はフィールド数で落ちる
  return collect(raw.split(LEGACY_ENTRY_SEPARATOR), (part) => {
    const fields = part.split(LEGACY_FIELD_SEPARATOR);
    if (fields.length !== LEGACY_FIELD_COUNT) {
      return undefined;
    }
    return parseFields(fields, ([pages = "", created = ""]) =>
      COUNT_PATTERN.test(pages) && COUNT_PATTERN.test(created)
        ? { pages: Number(pages), created: Number(created), wc: 0, wo: 0, links: 0 }
        : undefined,
    );
  });
}

/** 署名対象のフィールド。`p` はエントリの数だけ、出現順に並べる (v1 は 1 つ)。 */
function signedFields(
  version: string,
  fields: Pick<BeaconFields, "uid" | "kid" | "time">,
  entries: readonly string[],
): [string, string][] {
  return [
    [INGEST_PARAM.version, version],
    [INGEST_PARAM.uid, fields.uid],
    [INGEST_PARAM.kid, fields.kid],
    [INGEST_PARAM.time, String(fields.time)],
    ...entries.map((raw): [string, string] => [INGEST_PARAM.entries, raw]),
  ];
}

/** `p` 以外のキー。どれもちょうど 1 回。 */
const SINGLE_KEYS: readonly string[] = Object.values(INGEST_PARAM).filter(
  (key) => key !== INGEST_PARAM.entries,
);

/** キーの過不足と重複を見る。`p` だけは 1 回以上を認める (件数は版ごとに見る)。 */
function hasExpectedKeys(search: URLSearchParams): boolean {
  const keys = [...search.keys()];
  const count = (key: string) => keys.filter((k) => k === key).length;
  return (
    SINGLE_KEYS.every((key) => count(key) === 1) &&
    count(INGEST_PARAM.entries) >= 1 &&
    keys.every((key) => key === INGEST_PARAM.entries || SINGLE_KEYS.includes(key))
  );
}

/**
 * 受け口のクエリを読む。署名の**検証はしない** (鍵を引くのは Worker)。
 *
 * **署名が 64 バイトでなければここで拒否する。** DER を渡されたときに verify が静かに `false` を返し、
 * 「署名が違う」(403) と取り違えるのを防ぐ (ADR-0009)。
 */
export function parseIngestQuery(search: URLSearchParams): ParseResult {
  if (!hasExpectedKeys(search)) {
    return { ok: false, reason: "keys" };
  }

  const get = (key: string) => search.get(key) ?? "";
  const version = get(INGEST_PARAM.version);
  if (version !== INGEST_VERSION && version !== LEGACY_VERSION) {
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
  const rawEntries = search.getAll(INGEST_PARAM.entries);
  const entries =
    version === INGEST_VERSION
      ? parseEntries(rawEntries)
      : rawEntries.length === 1
        ? parseLegacyEntries(rawEntries[0] ?? "")
        : undefined;
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
      signingInput: signingInput(
        INGEST_PATH,
        signedFields(version, { uid, kid, time }, rawEntries),
      ),
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
  const pairs = signedFields(INGEST_VERSION, fields, entries);
  const signature = await signer(signingInput(INGEST_PATH, pairs));
  if (signature.length !== SIGNATURE_BYTES) {
    throw new RangeError(`署名は ${SIGNATURE_BYTES} バイト: ${signature.length}`);
  }

  const url = new URL(INGEST_PATH, origin);
  for (const [key, value] of pairs) {
    url.searchParams.append(key, value);
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
