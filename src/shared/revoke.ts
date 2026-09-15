/**
 * デバイスの失効 `GET /v1/revoke.gif` の取り決め (design §6)。UserScript が組み立て、Worker が読む。
 *
 * ```
 * /v1/revoke.gif?v=1&u=<uid>&d=<署名する kid>&x=<消す kid>&t=<unix秒>&sig=<base64url>
 * ```
 *
 * - **`DELETE` は使えない。** CSP が `connect-src` を塞いでいるので、破壊的操作も画像ビーコンになる (ADR-0001)
 * - そのぶん**リプレイ窓を 60 秒に縮める** (記録の 300 秒より狭い)。署名が要るので、
 *   URL がログやリンクプレビューに残っても窓の外なら効かない
 * - `x` には自分の kid も、ほかの端末の kid も入れられる (登録は同じ uid の下にある)
 *
 * 形の読み方は `beacon.ts` と同じ約束。キーは過不足も重複も許さず、値は先頭と末尾を固定して照合する。
 * 時刻の窓は「今」に依るのでここでは見ない (Worker が見る)。
 */
import { decodeBase64url, encodeBase64url } from "./base64url.ts";
import { isValidKid, isValidUid } from "./ids.ts";
import { SIGNATURE_BYTES, signingInput } from "./sign.ts";

export const REVOKE_PATH = "/v1/revoke.gif";

const REVOKE_VERSION = "1";

/** クエリの名前。 */
export const REVOKE_PARAM = {
  version: "v",
  uid: "u",
  kid: "d",
  target: "x",
  time: "t",
  signature: "sig",
} as const;

/**
 * 署名した時刻とサーバ時刻のずれの上限 (design §6)。
 * **破壊的な操作なので、記録の `REPLAY_WINDOW_SECONDS` (300) より狭い。**
 */
export const REVOKE_WINDOW_SECONDS = 60;

export type RevokeFields = {
  readonly uid: string;
  /** 署名する鍵 (この端末) */
  readonly kid: string;
  /** 失効させる鍵 */
  readonly target: string;
  /** unix 秒 */
  readonly time: number;
};

type Revocation = RevokeFields & {
  readonly signature: Uint8Array<ArrayBuffer>;
  readonly signingInput: string;
};

export type RevokeError = "keys" | "version" | "uid" | "kid" | "target" | "time" | "signature";

export type RevokeParseResult =
  | { readonly ok: true; readonly revocation: Revocation }
  | { readonly ok: false; readonly reason: RevokeError };

const TIME_PATTERN = /^[1-9]\d{0,10}$/;

const EXPECTED_KEYS: readonly string[] = Object.values(REVOKE_PARAM);

function signedFields(fields: RevokeFields): [string, string][] {
  return [
    [REVOKE_PARAM.version, REVOKE_VERSION],
    [REVOKE_PARAM.uid, fields.uid],
    [REVOKE_PARAM.kid, fields.kid],
    [REVOKE_PARAM.target, fields.target],
    [REVOKE_PARAM.time, String(fields.time)],
  ];
}

/**
 * 失効のクエリを読む。署名の**検証はしない** (鍵を引くのは Worker)。
 *
 * **署名が 64 バイトでなければここで拒否する** (`beacon.ts` と同じ。ADR-0009)。
 */
export function parseRevokeQuery(search: URLSearchParams): RevokeParseResult {
  const keys = [...search.keys()];
  if (keys.length !== EXPECTED_KEYS.length || EXPECTED_KEYS.some((key) => !keys.includes(key))) {
    return { ok: false, reason: "keys" };
  }

  const get = (key: string) => search.get(key) ?? "";
  if (get(REVOKE_PARAM.version) !== REVOKE_VERSION) {
    return { ok: false, reason: "version" };
  }
  const uid = get(REVOKE_PARAM.uid);
  if (!isValidUid(uid)) {
    return { ok: false, reason: "uid" };
  }
  const kid = get(REVOKE_PARAM.kid);
  if (!isValidKid(kid)) {
    return { ok: false, reason: "kid" };
  }
  const target = get(REVOKE_PARAM.target);
  if (!isValidKid(target)) {
    return { ok: false, reason: "target" };
  }
  const rawTime = get(REVOKE_PARAM.time);
  if (!TIME_PATTERN.test(rawTime)) {
    return { ok: false, reason: "time" };
  }
  const signature = decodeBase64url(get(REVOKE_PARAM.signature));
  if (signature?.length !== SIGNATURE_BYTES) {
    return { ok: false, reason: "signature" };
  }

  const fields = { uid, kid, target, time: Number(rawTime) };
  return {
    ok: true,
    revocation: {
      ...fields,
      signature,
      signingInput: signingInput(REVOKE_PATH, signedFields(fields)),
    },
  };
}

/** 失効の URL を組み立てる。署名は `signer` に任せる (`buildIngestUrl` と同じ形)。 */
export async function buildRevokeUrl(
  origin: string,
  fields: RevokeFields,
  signer: (input: string) => Promise<Uint8Array<ArrayBuffer>>,
): Promise<string> {
  const pairs = signedFields(fields);
  const signature = await signer(signingInput(REVOKE_PATH, pairs));
  if (signature.length !== SIGNATURE_BYTES) {
    throw new RangeError(`署名は ${SIGNATURE_BYTES} バイト: ${signature.length}`);
  }

  const url = new URL(REVOKE_PATH, origin);
  for (const [key, value] of pairs) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set(REVOKE_PARAM.signature, encodeBase64url(signature));
  return url.href;
}

/** 応答の GIF の幅 = これ + ビット (16〜17)。16 から始める理由は `beacon.ts` と同じ。 */
export const REVOKE_WIDTH_BASE = 16;

export type RevokeOutcome = {
  /** `keys` の行を消した。**既に無ければ `false`** (押し直しても成功にする) */
  readonly removed: boolean;
};

const REMOVED_BIT = 1;

export function revokeWidth(outcome: RevokeOutcome): number {
  return REVOKE_WIDTH_BASE + (outcome.removed ? REMOVED_BIT : 0);
}

/** 幅から結果を読む。取り決めの範囲 (16〜17) の外なら `undefined`。 */
export function readRevokeWidth(width: number): RevokeOutcome | undefined {
  const bits = width - REVOKE_WIDTH_BASE;
  if (!Number.isInteger(bits) || bits < 0 || bits > REMOVED_BIT) {
    return undefined;
  }
  return { removed: (bits & REMOVED_BIT) !== 0 };
}
