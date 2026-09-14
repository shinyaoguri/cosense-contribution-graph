/**
 * 署名の検証に使う公開鍵を引く。
 *
 * **鍵は `keys` テーブルに (uid, kid) で登録したデバイスの鍵だけ** (design §5)。登録した uid の記録にしか使えない。
 * 行を入れるデバイス登録は段階 4 で、それまでは記録が全部 403 になる (Issue #54 で試験用の公開鍵を消した)。
 */
import { importVerifyKey, PUBLIC_KEY_BYTES } from "../shared/sign.ts";

/** uid と kid から検証用の鍵を引く。無ければ `undefined`。D1 が失敗したら throw する。 */
export type ResolveKey = (uid: string, kid: string) => Promise<CryptoKey | undefined>;

/**
 * `keys` テーブルから引く。
 *
 * **保存された公開鍵が壊れていても例外にせず `undefined`** (その鍵の記録を 403 にする)。
 * D1 自体の失敗は throw のまま返し、受け口が 500 にする。
 */
export function d1KeyResolver(db: D1Database): ResolveKey {
  return async (uid, kid) => {
    const row = await db
      .prepare("SELECT pubkey FROM keys WHERE uid = ? AND kid = ?")
      .bind(uid, kid)
      .first<{ pubkey: unknown }>();
    // D1 の BLOB は ArrayBuffer か数値の配列で返る (ingest.ts の bitmapFrom と同じ扱い)
    const value = row?.pubkey;
    const publicKey =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : Array.isArray(value)
          ? Uint8Array.from(value, Number)
          : undefined;
    if (publicKey?.length !== PUBLIC_KEY_BYTES) {
      return undefined;
    }
    try {
      return await importVerifyKey(publicKey);
    } catch {
      // 65 バイトでも曲線上の点でなければ importKey が失敗する
      return undefined;
    }
  };
}
