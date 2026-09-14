/**
 * 記録の疎通確認 (Issue #36)。試しの活動を署名して `GET /v1/p.gif` に送り、共有 SVG の URL を出す。
 *
 * - **鍵は `extractable: false` で作り、IndexedDB に `CryptoKey` のまま置く** (design §3)。秘密鍵は JS にも出ない
 * - **uid は試験用の乱数。** サインイン (段階 4) がまだ無いので、20 バイトの乱数をこのブラウザの localStorage に置く。
 *   公開定数にすると、ph を既知のプロジェクト名の辞書で逆引きできてしまう
 * - **送るのは今日の固定パターン。** センサー (段階 5) はまだ無い。固定なので、2 回目は Worker が「変化なし」を返す
 * - **プロジェクト名は送らない。** URL に載るのは uid でソルトした ph だけ (design §9)
 *
 * Worker は `wrangler.jsonc` の `TRIAL_PUBLIC_KEY` にある公開鍵でだけ検証する。登録する前は 403 なので
 * 「届かなかった」になる。ダイアログに出す公開鍵を持ち主が登録する。
 */
import { encodeBase64url } from "../shared/base64url.ts";
import { buildIngestUrl, type Entry, readIngestWidth } from "../shared/beacon.ts";
import { bitmapOf } from "../shared/bits.ts";
import { isValidUid, kidOf, PH_ALL, phOf, publicIdOf, UID_BYTES } from "../shared/ids.ts";
import { exportPublicKey, generateSigningKeyPair, sign } from "../shared/sign.ts";
import { type ImageOptions, requestImage } from "./image.ts";
import { WORKER_ORIGIN } from "./probe.ts";

/** 試験用の uid を置く localStorage のキー。 */
export const TRIAL_UID_KEY = "cosense-grass:trial:uid";

/**
 * 今日の固定パターン。0:00〜0:04 を書き、0:00〜0:14 を読んだことにする。
 * 同じ分の読みは書きに数えるので、書き 5 分・読み 10 分の合計 15 分 (デッドゾーン 3 分を超えて色が付く)。
 * 0:00 からにするのは、いつ押しても過去の分になるため。
 */
const TRIAL_WRITE_MINUTES = [0, 1, 2, 3, 4] as const;
const TRIAL_READ_MINUTES = Array.from({ length: 15 }, (_, i) => i);

/** 鍵ペアの置き場。本物は IndexedDB (`indexedDbKeyStore`)、テストは Map。 */
export type KeyStore = {
  load(): Promise<CryptoKeyPair | undefined>;
  save(pair: CryptoKeyPair): Promise<void>;
};

export type RecordDependencies = {
  readonly keyStore: KeyStore;
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly now: () => Date;
  readonly send: (url: string) => Promise<RecordResult>;
};

export type RecordResult =
  | { readonly kind: "written" }
  | { readonly kind: "unchanged" }
  /** 画像は読めたが、幅が取り決めの外 */
  | { readonly kind: "unexpected"; readonly width: number }
  /** 画像として読めなかった。鍵が未登録 (403)・形の不一致 (400)・サーバの失敗 (500) を区別できない */
  | { readonly kind: "error" }
  | { readonly kind: "timeout" };

export type RecordReport = {
  readonly result: RecordResult;
  /** 鍵をこの操作で作ったか (false なら IndexedDB から読み戻した) */
  readonly createdKey: boolean;
  /** 65 バイトの公開鍵の base64url (87 文字)。`TRIAL_PUBLIC_KEY` に登録する値 */
  readonly publicKey: string;
  readonly kid: string;
  readonly day: string;
  readonly wholeGraphUrl: string;
  readonly projectGraphUrl: string;
};

/** ローカル時刻の今日。day はクライアントのローカル日付で決める (ADR-0002)。 */
export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function loadOrCreateKey(
  store: KeyStore,
): Promise<{ pair: CryptoKeyPair; created: boolean }> {
  const stored = await store.load();
  if (stored) {
    return { pair: stored, created: false };
  }
  const pair = await generateSigningKeyPair();
  await store.save(pair);
  return { pair, created: true };
}

function loadOrCreateUid(storage: RecordDependencies["storage"]): string {
  const stored = storage.getItem(TRIAL_UID_KEY);
  // 形の違う値 (手で書き換えた等) は作り直す。そのまま送ると Worker が 400 を返し続ける
  if (stored !== null && isValidUid(stored)) {
    return stored;
  }
  const uid = encodeBase64url(crypto.getRandomValues(new Uint8Array(UID_BYTES)));
  storage.setItem(TRIAL_UID_KEY, uid);
  return uid;
}

export async function runRecord(
  projectName: string,
  deps: RecordDependencies,
): Promise<RecordReport> {
  const { pair, created } = await loadOrCreateKey(deps.keyStore);
  const publicKey = await exportPublicKey(pair.publicKey);
  const kid = await kidOf(publicKey);
  const uid = loadOrCreateUid(deps.storage);
  const ph = await phOf(uid, projectName);

  const now = deps.now();
  const day = localDay(now);
  const pattern = (entryPh: string): Entry => ({
    ph: entryPh,
    day,
    wbits: bitmapOf(TRIAL_WRITE_MINUTES),
    rbits: bitmapOf(TRIAL_READ_MINUTES),
    pages: 1,
    created: 0,
  });
  // 合算の行は全プロジェクトを OR したもの。試しの送信は 1 プロジェクト分なので同じ中身になる
  const url = await buildIngestUrl(
    WORKER_ORIGIN,
    { uid, kid, time: Math.floor(now.getTime() / 1000), entries: [pattern(PH_ALL), pattern(ph)] },
    (input) => sign(pair.privateKey, input),
  );

  const graphUrl = async (graphPh: string) =>
    new URL(`/v1/g/${await publicIdOf(uid, graphPh)}.svg`, WORKER_ORIGIN).href;

  return {
    result: await deps.send(url),
    createdKey: created,
    publicKey: encodeBase64url(publicKey),
    kid,
    day,
    wholeGraphUrl: await graphUrl(PH_ALL),
    projectGraphUrl: await graphUrl(ph),
  };
}

/** 受け口へ画像 GET で送り、幅を読む。 */
export async function sendRecord(url: string, options: ImageOptions = {}): Promise<RecordResult> {
  const result = await requestImage(url, options);
  if (result.kind !== "loaded") {
    return result;
  }
  const outcome = readIngestWidth(result.width);
  if (!outcome) {
    return { kind: "unexpected", width: result.width };
  }
  return { kind: outcome.written ? "written" : "unchanged" };
}

export function describeRecord(result: RecordResult): string {
  switch (result.kind) {
    case "written":
      return "書いた (幅 17)";
    case "unchanged":
      return "変化なし (幅 16。同じ中身は 2 回目から書かない)";
    case "unexpected":
      return `★画像は読めたが幅が想定外 (${result.width})`;
    case "error":
      return "★届かなかった (鍵が未登録・形の不一致・サーバの失敗のどれか)";
    case "timeout":
      return "★15 秒で応答が無い";
  }
}

const DB_NAME = "cosense-grass";
const STORE_NAME = "keys";
const TRIAL_KEY = "trial";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/**
 * IndexedDB の鍵の置き場。**`CryptoKey` は structured clone できるので、鍵の中身を JS に出さずに保存・読み戻しできる**
 * (design §3)。IndexedDB はオリジン単位なので、scrapbox.io のどのプロジェクトからも同じ鍵が読める。
 *
 * jsdom に IndexedDB が無いので単体テストは Map で置き換える。読み戻しは Cosense 上で 2 回押して確かめる
 * (段階 2 の未確認事項。Firefox に読み出し失敗の報告がある)。
 */
export const indexedDbKeyStore: KeyStore = {
  async load() {
    const stored = await withStore<unknown>("readonly", (store) => store.get(TRIAL_KEY));
    if (
      typeof stored === "object" &&
      stored !== null &&
      "privateKey" in stored &&
      "publicKey" in stored
    ) {
      return stored as CryptoKeyPair;
    }
    return undefined;
  },
  async save(pair) {
    await withStore("readwrite", (store) =>
      store.put({ privateKey: pair.privateKey, publicKey: pair.publicKey }, TRIAL_KEY),
    );
  },
};
