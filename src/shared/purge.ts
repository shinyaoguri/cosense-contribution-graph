/**
 * 全データの削除 `GET /v1/delete.gif` の取り決め (design §6)。UserScript が組み立て、Worker が読む。
 *
 * ```
 * /v1/delete.gif?v=1&u=<uid>&d=<kid>&confirm=1&t=<unix秒>&sig=<base64url>
 * ```
 *
 * - **`confirm=1` を必須にする** (design §6)。押し間違いの URL がそのまま効かないよう、
 *   署名の対象にも入れる。値は `1` 以外を受けない
 * - リプレイ窓は失効と同じ 60 秒 (`revoke.ts`)。破壊的操作なので記録の 300 秒より狭い
 * - 形の読み方は `beacon.ts`・`revoke.ts` と同じ約束
 */
import { decodeBase64url, encodeBase64url } from "./base64url.ts";
import { isValidKid, isValidUid } from "./ids.ts";
import { SIGNATURE_BYTES, signingInput } from "./sign.ts";

export const PURGE_PATH = "/v1/delete.gif";

const PURGE_VERSION = "1";

/** `confirm` に入れる唯一の値。 */
const PURGE_CONFIRM = "1";

/** クエリの名前。 */
export const PURGE_PARAM = {
  version: "v",
  uid: "u",
  kid: "d",
  confirm: "confirm",
  time: "t",
  signature: "sig",
} as const;

/** 署名した時刻とサーバ時刻のずれの上限 (design §6)。**失効と同じ 60 秒。** */
export const PURGE_WINDOW_SECONDS = 60;

export type PurgeFields = {
  readonly uid: string;
  /** 署名する鍵 (この端末) */
  readonly kid: string;
  /** unix 秒 */
  readonly time: number;
};

type Purge = PurgeFields & {
  readonly signature: Uint8Array<ArrayBuffer>;
  readonly signingInput: string;
};

export type PurgeError = "keys" | "version" | "uid" | "kid" | "confirm" | "time" | "signature";

export type PurgeParseResult =
  | { readonly ok: true; readonly purge: Purge }
  | { readonly ok: false; readonly reason: PurgeError };

const TIME_PATTERN = /^[1-9]\d{0,10}$/;

const EXPECTED_KEYS: readonly string[] = Object.values(PURGE_PARAM);

function signedFields(fields: PurgeFields): [string, string][] {
  return [
    [PURGE_PARAM.version, PURGE_VERSION],
    [PURGE_PARAM.uid, fields.uid],
    [PURGE_PARAM.kid, fields.kid],
    [PURGE_PARAM.confirm, PURGE_CONFIRM],
    [PURGE_PARAM.time, String(fields.time)],
  ];
}

/** 削除のクエリを読む。署名の**検証はしない** (鍵を引くのは Worker)。 */
export function parsePurgeQuery(search: URLSearchParams): PurgeParseResult {
  const keys = [...search.keys()];
  if (keys.length !== EXPECTED_KEYS.length || EXPECTED_KEYS.some((key) => !keys.includes(key))) {
    return { ok: false, reason: "keys" };
  }

  const get = (key: string) => search.get(key) ?? "";
  if (get(PURGE_PARAM.version) !== PURGE_VERSION) {
    return { ok: false, reason: "version" };
  }
  const uid = get(PURGE_PARAM.uid);
  if (!isValidUid(uid)) {
    return { ok: false, reason: "uid" };
  }
  const kid = get(PURGE_PARAM.kid);
  if (!isValidKid(kid)) {
    return { ok: false, reason: "kid" };
  }
  if (get(PURGE_PARAM.confirm) !== PURGE_CONFIRM) {
    return { ok: false, reason: "confirm" };
  }
  const rawTime = get(PURGE_PARAM.time);
  if (!TIME_PATTERN.test(rawTime)) {
    return { ok: false, reason: "time" };
  }
  const signature = decodeBase64url(get(PURGE_PARAM.signature));
  if (signature?.length !== SIGNATURE_BYTES) {
    return { ok: false, reason: "signature" };
  }

  const fields = { uid, kid, time: Number(rawTime) };
  return {
    ok: true,
    purge: {
      ...fields,
      signature,
      signingInput: signingInput(PURGE_PATH, signedFields(fields)),
    },
  };
}

/** 削除の URL を組み立てる。署名は `signer` に任せる (`buildRevokeUrl` と同じ形)。 */
export async function buildPurgeUrl(
  origin: string,
  fields: PurgeFields,
  signer: (input: string) => Promise<Uint8Array<ArrayBuffer>>,
): Promise<string> {
  const pairs = signedFields(fields);
  const signature = await signer(signingInput(PURGE_PATH, pairs));
  if (signature.length !== SIGNATURE_BYTES) {
    throw new RangeError(`署名は ${SIGNATURE_BYTES} バイト: ${signature.length}`);
  }

  const url = new URL(PURGE_PATH, origin);
  for (const [key, value] of pairs) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set(PURGE_PARAM.signature, encodeBase64url(signature));
  return url.href;
}

/** 応答の GIF の幅 = これ + ビット (16〜17)。16 から始める理由は `beacon.ts` と同じ。 */
export const PURGE_WIDTH_BASE = 16;

export type PurgeOutcome = {
  /** 1 行でも消した。**もともと何も無ければ `false`** (どちらも成功) */
  readonly deleted: boolean;
};

const DELETED_BIT = 1;

export function purgeWidth(outcome: PurgeOutcome): number {
  return PURGE_WIDTH_BASE + (outcome.deleted ? DELETED_BIT : 0);
}

/** 幅から結果を読む。取り決めの範囲 (16〜17) の外なら `undefined`。 */
export function readPurgeWidth(width: number): PurgeOutcome | undefined {
  const bits = width - PURGE_WIDTH_BASE;
  if (!Number.isInteger(bits) || bits < 0 || bits > DELETED_BIT) {
    return undefined;
  }
  return { deleted: (bits & DELETED_BIT) !== 0 };
}
