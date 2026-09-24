/**
 * UserScript と Worker の両方から使う識別子の規定 (design §3)。
 *
 * **このファイルは DOM lib と workerd lib の両方で型検査される**
 * (tsconfig.userscript.json と tsconfig.worker.json の両方が include する)。
 * どちらか片方にしか無いグローバルを使うと型検査が落ちるので、
 * ここには環境に依らないコードだけを置く。
 *
 * ```
 * uid        HMAC-SHA256(WORKER_SECRET, "google:" + sub) の先頭 160 bit を base64url (27 文字)
 * kid        SHA-256(公開鍵 65 バイト)[0:16]
 * ph         SHA-256(uid + ":" + プロジェクト名)[0:16]。'*' は全体
 * publicId   SHA-256(uid + ":" + ph)[0:32]。全体用は ph = '*'
 * dataKey    SHA-256("data:" + uid + ":" + ph)[0:32]。日ごとの集計値の JSON の URL に publicId と並べる
 * ```
 */
import { decodeBase64url } from "./base64url.ts";
import { sha256Hex } from "./hash.ts";
import { PUBLIC_KEY_BYTES } from "./sign.ts";

/** uid のバイト数 (160 bit)。base64url にすると 27 文字 (ADR-0013 決定 2)。 */
export const UID_BYTES = 20;

/**
 * プロジェクト識別子 `ph` の桁数。
 *
 * ADR-0007 決定 2 の改訂で 12 桁から 16 桁 (64 bit) に広げた。
 * `SHA-256(uid + ":" + プロジェクト名)` の先頭を取る。
 */
export const PH_LENGTH = 16;

/** 全プロジェクトの合算を表す予約値。 */
export const PH_ALL = "*";

/** デバイス識別子 `kid` の桁数。 */
export const KID_LENGTH = 16;

/** 共有 URL の識別子 `publicId` の桁数。 */
export const PUBLIC_ID_LENGTH = 32;

const PH_PATTERN = new RegExp(`^[0-9a-f]{${PH_LENGTH}}$`);
const KID_PATTERN = new RegExp(`^[0-9a-f]{${KID_LENGTH}}$`);

/**
 * `ph` として受け付けてよい値かを判定する。
 *
 * 16 桁の小文字 16 進数か、合算を表す `*` のみ。
 * 大文字を弾くのは、同じプロジェクトが 2 行に分かれるのを防ぐため。
 */
export function isValidPh(value: string): boolean {
  return value === PH_ALL || PH_PATTERN.test(value);
}

/**
 * `uid` として受け付けてよい値か。20 バイトの正規な base64url (27 文字) だけ。
 * 末尾の余りビットが立っている 27 文字は、同じ uid の別表記になるので拒否する。
 */
export function isValidUid(value: string): boolean {
  return decodeBase64url(value)?.length === UID_BYTES;
}

const PUBLIC_ID_PATTERN = new RegExp(`^[0-9a-f]{${PUBLIC_ID_LENGTH}}$`);

/** 共有 URL の `publicId` の形か (32 桁の小文字 16 進数)。形が違えば D1 を引かずに 404 にする。 */
export function isValidPublicId(value: string): boolean {
  return PUBLIC_ID_PATTERN.test(value);
}

/** 日ごとの集計値の JSON を開く鍵 `dataKey` の桁数 (128 bit。ADR-0020)。 */
export const DATA_KEY_LENGTH = 32;

const DATA_KEY_PATTERN = new RegExp(`^[0-9a-f]{${DATA_KEY_LENGTH}}$`);

/** `dataKey` の形か (32 桁の小文字 16 進数)。形が違えば D1 を引かずに 404 にする。 */
export function isValidDataKey(value: string): boolean {
  return DATA_KEY_PATTERN.test(value);
}

export function isValidKid(value: string): boolean {
  return KID_PATTERN.test(value);
}

/** プロジェクト名から `ph` を作る。**uid でソルトする** (辞書で逆引きされないように。design §3)。 */
export function phOf(uid: string, projectName: string): Promise<string> {
  return sha256Hex(`${uid}:${projectName}`, PH_LENGTH);
}

/**
 * 共有 URL の `publicId`。一方向なので、プロジェクト用から全体用も他のプロジェクト用も導けない
 * (ADR-0007 決定 3)。
 */
export function publicIdOf(uid: string, ph: string): Promise<string> {
  return sha256Hex(`${uid}:${ph}`, PUBLIC_ID_LENGTH);
}

/**
 * 日ごとの集計値の JSON を開く鍵 (ADR-0020)。URL は `/v1/g/{publicId}/{dataKey}.json`。
 *
 * **`publicId` からは導けない。** 計算に uid が要るので、草の URL を受け取った人は内訳の URL を作れない。
 * 先頭の `data:` で `publicId` の入力 (`uid:ph`) と分ける。uid は `:` を含まないので、
 * `publicId` の入力の最初の `:` は 28 文字目、こちらは 5 文字目になり、同じ入力にならない。
 */
export function dataKeyOf(uid: string, ph: string): Promise<string> {
  return sha256Hex(`data:${uid}:${ph}`, DATA_KEY_LENGTH);
}

/** 公開鍵 (65 バイトの非圧縮 SEC1) から `kid` を作る。**文字列ではなくバイト列をハッシュする。** */
export function kidOf(publicKey: Uint8Array<ArrayBuffer>): Promise<string> {
  if (publicKey.length !== PUBLIC_KEY_BYTES) {
    throw new RangeError(`公開鍵は ${PUBLIC_KEY_BYTES} バイト: ${publicKey.length}`);
  }
  return sha256Hex(publicKey, KID_LENGTH);
}
