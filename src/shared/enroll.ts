/**
 * デバイスの登録 `GET /v1/enroll.gif` の取り決め (design §6)。UserScript が組み立て、Worker が読む。
 *
 * ```
 * /v1/enroll.gif?v=1&u=<uid>&k=<公開鍵 base64url>&tok=<登録トークン>&sig=<base64url>
 * ```
 *
 * **登録する鍵そのもので署名する** (所有証明。ADR-0009 の 2026-09-14 の改訂)。署名対象は経路が先頭の
 * 改行区切り (`sign.ts`) なので、`/v1/p.gif` の署名をここへ持ち込めない。
 * 登録トークンは 1 回しか使えないので、リプレイ窓の `t` は持たない。
 *
 * 形は `beacon.ts` と同じく厳密に読む。両 lib で型検査され、両環境でテストされる。
 */
import { decodeBase64url, encodeBase64url } from "./base64url.ts";
import { isValidUid } from "./ids.ts";
import { PUBLIC_KEY_BYTES, SIGNATURE_BYTES, signingInput } from "./sign.ts";

export const ENROLL_PATH = "/v1/enroll.gif";

const ENROLL_VERSION = "1";

/** クエリの名前。 */
export const ENROLL_PARAM = {
  version: "v",
  uid: "u",
  publicKey: "k",
  token: "tok",
  signature: "sig",
} as const;

/** 登録トークンは 128 bit (base64url で 22 文字)。 */
export const ENROLL_TOKEN_BYTES = 16;

/** 署名される中身。 */
export type EnrollmentFields = {
  readonly uid: string;
  /** 65 バイトの非圧縮 SEC1 */
  readonly publicKey: Uint8Array<ArrayBuffer>;
  /** `/auth/callback` が発行した登録トークン (base64url) */
  readonly token: string;
};

type Enrollment = EnrollmentFields & {
  readonly signature: Uint8Array<ArrayBuffer>;
  /** 検証に使う署名対象 */
  readonly signingInput: string;
};

/** 拒否した理由。ログに出す (値そのものは出さない)。 */
type EnrollError = "keys" | "version" | "uid" | "key" | "token" | "signature";

type ParseResult =
  | { readonly ok: true; readonly enrollment: Enrollment }
  | { readonly ok: false; readonly reason: EnrollError };

/** 登録トークンの形か (16 バイトの正規な base64url)。 */
export function isValidEnrollToken(token: string): boolean {
  return decodeBase64url(token)?.length === ENROLL_TOKEN_BYTES;
}

function signedFields(uid: string, publicKey: string, token: string): [string, string][] {
  return [
    [ENROLL_PARAM.version, ENROLL_VERSION],
    [ENROLL_PARAM.uid, uid],
    [ENROLL_PARAM.publicKey, publicKey],
    [ENROLL_PARAM.token, token],
  ];
}

const EXPECTED_KEYS: readonly string[] = Object.values(ENROLL_PARAM);

/** 登録のクエリを読む。署名の**検証はしない** (公開鍵の読み込みと検証は Worker)。 */
export function parseEnrollQuery(search: URLSearchParams): ParseResult {
  const keys = [...search.keys()];
  if (keys.length !== EXPECTED_KEYS.length || EXPECTED_KEYS.some((key) => !keys.includes(key))) {
    return { ok: false, reason: "keys" };
  }

  const get = (key: string) => search.get(key) ?? "";
  if (get(ENROLL_PARAM.version) !== ENROLL_VERSION) {
    return { ok: false, reason: "version" };
  }
  const uid = get(ENROLL_PARAM.uid);
  if (!isValidUid(uid)) {
    return { ok: false, reason: "uid" };
  }
  const rawKey = get(ENROLL_PARAM.publicKey);
  const publicKey = decodeBase64url(rawKey);
  if (publicKey?.length !== PUBLIC_KEY_BYTES) {
    return { ok: false, reason: "key" };
  }
  const token = get(ENROLL_PARAM.token);
  if (!isValidEnrollToken(token)) {
    return { ok: false, reason: "token" };
  }
  // DER は「署名が違う」(403) ではなく「形が違う」(400) にする (beacon.ts と同じ)
  const signature = decodeBase64url(get(ENROLL_PARAM.signature));
  if (signature?.length !== SIGNATURE_BYTES) {
    return { ok: false, reason: "signature" };
  }

  return {
    ok: true,
    enrollment: {
      uid,
      publicKey,
      token,
      signature,
      signingInput: signingInput(ENROLL_PATH, signedFields(uid, rawKey, token)),
    },
  };
}

/** 登録の URL を組み立てる。署名は `signer` に任せる (登録する鍵の秘密鍵で署名する)。 */
export async function buildEnrollUrl(
  origin: string,
  fields: EnrollmentFields,
  signer: (input: string) => Promise<Uint8Array<ArrayBuffer>>,
): Promise<string> {
  if (
    !isValidUid(fields.uid) ||
    fields.publicKey.length !== PUBLIC_KEY_BYTES ||
    !isValidEnrollToken(fields.token)
  ) {
    throw new RangeError("登録の中身が取り決めの外");
  }
  const pairs = signedFields(fields.uid, encodeBase64url(fields.publicKey), fields.token);
  const signature = await signer(signingInput(ENROLL_PATH, pairs));
  if (signature.length !== SIGNATURE_BYTES) {
    throw new RangeError(`署名は ${SIGNATURE_BYTES} バイト: ${signature.length}`);
  }

  const url = new URL(ENROLL_PATH, origin);
  for (const [key, value] of pairs) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set(ENROLL_PARAM.signature, encodeBase64url(signature));
  return url.href;
}

/**
 * 応答の GIF の幅 = これ + ビットの和 (16〜17)。
 * 16 から始めるのは、途中の何かが返した 1×1 の画像を「届いた」と取り違えないため (`beacon.ts` と同じ)。
 */
export const ENROLL_WIDTH_BASE = 16;

/** Worker が登録した結果。 */
type EnrollOutcome = {
  /** 新しく登録した。**登録済みの鍵を別のトークンで送り直すと `false`** */
  readonly added: boolean;
};

const ADDED_BIT = 1;

export function enrollWidth(outcome: EnrollOutcome): number {
  return ENROLL_WIDTH_BASE + (outcome.added ? ADDED_BIT : 0);
}

/** 幅から結果を読む。取り決めの範囲 (16〜17) の外なら `undefined`。 */
export function readEnrollWidth(width: number): EnrollOutcome | undefined {
  const bits = width - ENROLL_WIDTH_BASE;
  if (!Number.isInteger(bits) || bits < 0 || bits > ADDED_BIT) {
    return undefined;
  }
  return { added: (bits & ADDED_BIT) !== 0 };
}
