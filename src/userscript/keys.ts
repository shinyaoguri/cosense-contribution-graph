/**
 * この端末の鍵と、それを登録した uid を IndexedDB に 1 レコードで持つ (design §3「デバイスの鍵」、§9「保存するもの」)。
 *
 * ```
 * IndexedDB cosense-grass (v1) / store keys / キー "device"
 *   { v: 1, uid, kid, privateKey: CryptoKey (extractable: false), publicKey: 65 バイトの raw, enrolledAt }
 * ```
 *
 * - **`CryptoKey` は structured clone できるので、秘密鍵の中身を JS に出さずに保存・読み戻しできる**。
 *   IndexedDB はオリジン単位なので、scrapbox.io のどのプロジェクトからも同じ鍵が読める
 * - **uid を localStorage に分けず、鍵と同じレコードに持つ。** 片方だけ消えて食い違わない
 * - 記録の疎通確認 (Issue #36) が同じ DB と store のキー `trial` を使っていた。**`trial` は読まない**
 *   (持ち主が消し忘れても本物の鍵と取り違えない)
 * - 読めない (Firefox に報告がある) ・形が違うときは、サインインし直せば新しい鍵で作り直す
 *
 * jsdom に IndexedDB が無いので、IndexedDB の実装は Cosense 上で確かめる。形の判定はテストで固定する。
 */
import { isValidUid, kidOf } from "../shared/ids.ts";
import { PUBLIC_KEY_BYTES } from "../shared/sign.ts";

const DB_NAME = "cosense-grass";
const DB_VERSION = 1;
const STORE_NAME = "keys";
const DEVICE_KEY = "device";
const RECORD_VERSION = 1;

export type DeviceRecord = {
  readonly v: typeof RECORD_VERSION;
  readonly uid: string;
  readonly kid: string;
  /** `extractable: false`。usages は `sign` だけ */
  readonly privateKey: CryptoKey;
  /** 65 バイトの非圧縮 SEC1 */
  readonly publicKey: Uint8Array<ArrayBuffer>;
  /** 登録した時刻 (ISO) */
  readonly enrolledAt: string;
};

export type DeviceRead =
  | { readonly kind: "found"; readonly record: DeviceRecord }
  | { readonly kind: "missing" }
  /** 知らない版の記録。新しい版のバンドルが書いた形を壊さないよう、上書きしない (store.ts と同じ約束) */
  | { readonly kind: "newer" }
  /** 形が違う・kid が合わない。サインインし直せば作り直す */
  | { readonly kind: "invalid" };

export type DeviceStore = {
  /** IndexedDB を開けなければ reject する (サインインし直しても直らない) */
  read(): Promise<DeviceRead>;
  write(record: DeviceRecord): Promise<void>;
};

/** 保存されていた値を読む。 */
export async function parseDeviceRecord(value: unknown): Promise<DeviceRead> {
  if (value === undefined) {
    return { kind: "missing" };
  }
  if (typeof value !== "object" || value === null) {
    return { kind: "invalid" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.v === "number" && record.v > RECORD_VERSION) {
    return { kind: "newer" };
  }
  const { uid, kid, privateKey, publicKey, enrolledAt } = record;
  if (
    record.v !== RECORD_VERSION ||
    typeof uid !== "string" ||
    !isValidUid(uid) ||
    typeof kid !== "string" ||
    !(publicKey instanceof Uint8Array) ||
    publicKey.length !== PUBLIC_KEY_BYTES ||
    typeof enrolledAt !== "string" ||
    !isSigningKey(privateKey)
  ) {
    return { kind: "invalid" };
  }
  // 別の realm (IndexedDB から読み戻した値) の Uint8Array でも使えるよう、この realm の配列に写す
  const bytes = new Uint8Array(publicKey);
  if ((await kidOf(bytes)) !== kid) {
    return { kind: "invalid" };
  }
  return {
    kind: "found",
    record: { v: RECORD_VERSION, uid, kid, privateKey, publicKey: bytes, enrolledAt },
  };
}

/**
 * ECDSA P-256 の署名用の秘密鍵か。**`instanceof CryptoKey` では見ない** (realm が違うと外れる)。
 */
function isSigningKey(value: unknown): value is CryptoKey {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const key = value as { type?: unknown; algorithm?: unknown; usages?: unknown };
  const algorithm = key.algorithm as { name?: unknown; namedCurve?: unknown } | undefined;
  return (
    key.type === "private" &&
    algorithm?.name === "ECDSA" &&
    algorithm.namedCurve === "P-256" &&
    Array.isArray(key.usages) &&
    key.usages.includes("sign")
  );
}

/** IndexedDB の実装。操作のたびに開き、終わったら閉じる (別の版のバンドルがバージョンを上げても詰まらない)。 */
export function createIndexedDbDeviceStore(factory: IDBFactory = indexedDB): DeviceStore {
  function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("IndexedDB が別のタブで使われていて開けない"));
    });
  }

  return {
    async read() {
      const db = await open();
      try {
        const value = await new Promise<unknown>((resolve, reject) => {
          const request = db
            .transaction(STORE_NAME, "readonly")
            .objectStore(STORE_NAME)
            .get(DEVICE_KEY);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return await parseDeviceRecord(value);
      } finally {
        db.close();
      }
    },
    async write(record) {
      const db = await open();
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(STORE_NAME, "readwrite");
          transaction.objectStore(STORE_NAME).put(record, DEVICE_KEY);
          // **コミットを待つ。** request の onsuccess はコミット前に来る
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () =>
            reject(transaction.error ?? new Error("IndexedDB の書き込みが中断された"));
        });
      } finally {
        db.close();
      }
    },
  };
}
