/**
 * 受け口のテストで使う、署名つきビーコンの組み立て。鍵はテストの中で生成する (秘密鍵をリポジトリに置かない)。
 */
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { buildIngestUrl, type Entry } from "../../src/shared/beacon.ts";
import { bitmapOf } from "../../src/shared/bits.ts";
import { kidOf, PH_ALL, UID_BYTES } from "../../src/shared/ids.ts";
import { exportPublicKey, generateSigningKeyPair, sign } from "../../src/shared/sign.ts";
import type { ResolveKey } from "../../src/worker/keys.ts";

export const ORIGIN = "https://example.com";

/** 2026-09-14 03:00 UTC (日本時間の正午)。 */
export const NOW = Date.UTC(2026, 8, 14, 3, 0, 0);
export const TODAY = "2026-09-14";

/** D1 はテストファイルの中で共有されるので、テストごとに別の uid を使う。 */
export function randomUid(): string {
  return encodeBase64url(crypto.getRandomValues(new Uint8Array(UID_BYTES)));
}

export function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    ph: PH_ALL,
    day: TODAY,
    wbits: bitmapOf([]),
    rbits: bitmapOf([]),
    pages: 0,
    created: 0,
    ...overrides,
  };
}

export type Signer = {
  readonly kid: string;
  readonly publicKey: Uint8Array<ArrayBuffer>;
  readonly resolveKey: ResolveKey;
  /** 署名つきの URL。`time` の既定は NOW */
  url(uid: string, entries: readonly Entry[], time?: number): Promise<URL>;
};

export async function createSigner(): Promise<Signer> {
  const pair = await generateSigningKeyPair();
  const publicKey = await exportPublicKey(pair.publicKey);
  const kid = await kidOf(publicKey);
  return {
    kid,
    publicKey,
    resolveKey: async (_uid, requested) => (requested === kid ? pair.publicKey : undefined),
    url: async (uid, entries, time = NOW / 1000) =>
      new URL(
        await buildIngestUrl(ORIGIN, { uid, kid, time, entries }, (input) =>
          sign(pair.privateKey, input),
        ),
      ),
  };
}

/** GIF の論理画面の幅 (6〜7 バイト目、リトルエンディアン)。 */
export async function gifWidth(res: Response): Promise<number> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  return (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8);
}
