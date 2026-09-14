/**
 * 署名の検証に使う公開鍵を引く。
 *
 * **段階 4 までは試験用の公開鍵 1 本だけ** (Issue #36)。`wrangler.jsonc` の `TRIAL_PUBLIC_KEY` にある鍵で、
 * kid が一致すればどの uid の記録にも使える。秘密鍵は持ち主のブラウザ (IndexedDB) にしか無い。
 * 段階 4 でデバイスごとの鍵 (`keys` テーブル) を引く実装に差し替える。
 */
import { decodeBase64url } from "../shared/base64url.ts";
import { kidOf } from "../shared/ids.ts";
import { importVerifyKey, PUBLIC_KEY_BYTES } from "../shared/sign.ts";

/** uid と kid から検証用の鍵を引く。無ければ `undefined`。 */
export type ResolveKey = (uid: string, kid: string) => Promise<CryptoKey | undefined>;

type TrialKey = { readonly kid: string; readonly key: CryptoKey };

async function loadTrialKey(configured: string): Promise<TrialKey | undefined> {
  const publicKey = decodeBase64url(configured);
  if (publicKey?.length !== PUBLIC_KEY_BYTES) {
    return undefined;
  }
  try {
    return { kid: await kidOf(publicKey), key: await importVerifyKey(publicKey) };
  } catch {
    // 65 バイトでも曲線上の点でなければ importKey が失敗する
    return undefined;
  }
}

// 設定値は isolate の中で変わらないので、読み込みは 1 回にする
const loaded = new Map<string, Promise<TrialKey | undefined>>();

/**
 * 試験用の公開鍵で引く。
 *
 * **空や形の違う値なら、どの kid にも鍵を返さない** (記録を全部 403 にする)。
 */
export function trialKeyResolver(configured: string): ResolveKey {
  let trial = loaded.get(configured);
  if (!trial) {
    trial = loadTrialKey(configured);
    loaded.set(configured, trial);
  }
  const pending = trial;
  return async (_uid, kid) => {
    const found = await pending;
    return found?.kid === kid ? found.key : undefined;
  };
}
