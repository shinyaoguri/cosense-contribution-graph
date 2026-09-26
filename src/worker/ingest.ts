/**
 * `GET /v1/p.gif` — 記録の受け口 (design §6)。
 *
 * 1. **形を見る (400)。** `parseIngestQuery` が厳密に読む。署名が 64 バイトでないもの (DER) もここで落ちる
 * 2. **日付の窓を見る (400)。** 未来の日と 30 日より古い日
 * 3. **時刻の窓・鍵・署名を見る (403)。** 鍵は D1 の `keys` から読むが、署名が通るまで書き込みには近づかせない
 * 4. D1 を 1 回の batch で読み、Worker でマージし、**変化したエントリだけ**を 1 回の batch で書く
 * 5. 200 と幅 16 (変化なし) / 17 (書いた) の透過 GIF を返す
 *
 * **D1 が throw したら 500。** 画像が返らないのでクライアントは onerror で失敗を知り、送信済みにしない。
 */
import {
  type Beacon,
  type BeaconError,
  type Entry,
  ingestWidth,
  parseIngestQuery,
} from "../shared/beacon.ts";
import { type Bitmap, isBitmap } from "../shared/bits.ts";
import { publicIdOf } from "../shared/ids.ts";
import { verify } from "../shared/sign.ts";
import { acceptsDay } from "./days.ts";
import type { ResolveKey } from "./keys.ts";
import { type DailyValues, mergeEntry, type StoredBits } from "./merge.ts";
import { gifResponse, plainResponse } from "./responses.ts";

/** 署名した時刻 `t` とサーバ時刻のずれの上限 (design §3)。 */
export const REPLAY_WINDOW_SECONDS = 300;

export type IngestDeps = {
  readonly db: D1Database;
  readonly resolveKey: ResolveKey;
  /** 現在時刻 (ミリ秒)。テストで固定する */
  readonly now: () => number;
};

/** ログに出す結果。値そのもの (uid・ph・kid) は出さない。 */
type Reason =
  | BeaconError
  | "day-window"
  | "time-window"
  | "unknown-key"
  | "bad-signature"
  | "conflict"
  | "d1"
  | "written"
  | "unchanged";

export async function handleIngest(url: URL, deps: IngestDeps): Promise<Response> {
  const parsed = parseIngestQuery(url.searchParams);
  if (!parsed.ok) {
    return reject(400, parsed.reason);
  }
  const { beacon } = parsed;
  const entries = beacon.entries.length;

  const nowMs = deps.now();
  if (!beacon.entries.every((entry) => acceptsDay(entry.day, nowMs))) {
    return reject(400, "day-window", entries);
  }
  if (Math.abs(nowMs / 1000 - beacon.time) > REPLAY_WINDOW_SECONDS) {
    return reject(403, "time-window", entries);
  }
  let key: CryptoKey | undefined;
  try {
    key = await deps.resolveKey(beacon.uid, beacon.kid);
  } catch {
    // 鍵は D1 から引く。読めなければ書き込みと同じく 500 にして再送させる
    return reject(500, "d1", entries);
  }
  if (!key) {
    return reject(403, "unknown-key", entries);
  }
  if (!(await verify(key, beacon.signature, beacon.signingInput))) {
    return reject(403, "bad-signature", entries);
  }

  let changed: number | "conflict";
  try {
    changed = await record(deps.db, beacon);
  } catch {
    // D1 のエラーには数値コードが無い。種別に依らず 500 にする (research §5)
    return reject(500, "d1", entries);
  }
  if (changed === "conflict") {
    return reject(500, "conflict", entries);
  }

  const written = changed > 0;
  log(200, written ? "written" : "unchanged", entries, changed);
  return gifResponse(ingestWidth({ written }));
}

const entryKey = (ph: string, day: string) => `${ph} ${day}`;

/**
 * D1 に記録する。書いたエントリの数を返す。
 *
 * **ビットマップは楽観的に書く。** 読んでから書くまでの間に別の送信 (別のタブや端末) が同じ行を書くと、
 * 素朴な UPSERT はそのビットを上書きして消す。読んだ値と一致するときだけ更新し (無かった行は INSERT して
 * 衝突したら何もしない)、1 行も変わらなければ `"conflict"` を返してクライアントに再送させる。
 * 全量を毎回送る (ADR-0002) ので、再送すれば消えかけたビットも戻る。
 *
 * daily は同じ batch で書いてよい。`merge.ts` の規則 (w と合計を max で守る) は、古い読み取りから計算した
 * 値で上書きしても値を減らさず、二重にも数えない。
 */
async function record(db: D1Database, beacon: Beacon): Promise<number | "conflict"> {
  const { uid, entries } = beacon;
  const phs = [...new Set(entries.map((entry) => entry.ph))];
  const publicIds = await Promise.all(phs.map((ph) => publicIdOf(uid, ph)));
  const pairs = entries.flatMap((entry) => [entry.ph, entry.day]);
  const rowValues = entries.map(() => "(?, ?)").join(", ");

  const [graphRows, bitsRows, dailyRows] = await db.batch<Record<string, unknown>>([
    db
      .prepare(`SELECT public_id FROM graphs WHERE public_id IN (${phs.map(() => "?").join(", ")})`)
      .bind(...publicIds),
    db
      .prepare(
        `SELECT ph, day, wbits, rbits FROM daybits WHERE uid = ? AND (ph, day) IN (VALUES ${rowValues})`,
      )
      .bind(uid, ...pairs),
    db
      .prepare(
        `SELECT ph, day, w, r, pages, created, wc, wo, links FROM daily WHERE uid = ? AND (ph, day) IN (VALUES ${rowValues})`,
      )
      .bind(uid, ...pairs),
  ]);

  const knownGraphs = new Set(graphRows?.results.map((row) => String(row.public_id)));
  const storedBits = new Map<string, StoredBits>(
    (bitsRows?.results ?? []).map((row) => [
      entryKey(String(row.ph), String(row.day)),
      { wbits: bitmapFrom(row.wbits), rbits: bitmapFrom(row.rbits) },
    ]),
  );
  const storedDaily = new Map<string, DailyValues>(
    (dailyRows?.results ?? []).map((row) => [
      entryKey(String(row.ph), String(row.day)),
      {
        w: Number(row.w),
        r: Number(row.r),
        pages: Number(row.pages),
        created: Number(row.created),
        wc: Number(row.wc),
        wo: Number(row.wo),
        links: Number(row.links),
      },
    ]),
  );

  const writes: D1PreparedStatement[] = [];
  // changes が 1 でなければ衝突とみなす文の位置
  const guarded: number[] = [];

  const newGraphs = phs
    .map((ph, i) => ({ ph, publicId: publicIds[i] ?? "" }))
    .filter(({ publicId }) => !knownGraphs.has(publicId));
  if (newGraphs.length > 0) {
    writes.push(
      db
        .prepare(
          `INSERT INTO graphs (public_id, uid, ph) VALUES ${newGraphs.map(() => "(?, ?, ?)").join(", ")} ON CONFLICT (public_id) DO NOTHING`,
        )
        .bind(...newGraphs.flatMap(({ ph, publicId }) => [publicId, uid, ph])),
    );
  }

  let changed = 0;
  for (const entry of entries) {
    const key = entryKey(entry.ph, entry.day);
    const stored = storedBits.get(key);
    const merged = mergeEntry(entry, stored, storedDaily.get(key));

    if (merged.bitsChanged) {
      writes.push(bitsStatement(db, uid, entry, merged.bits, stored));
      guarded.push(writes.length - 1);
    }
    if (merged.dailyChanged) {
      writes.push(dailyStatement(db, uid, entry, merged.daily));
    }
    if (merged.bitsChanged || merged.dailyChanged) {
      changed++;
    }
  }

  // **変化が無ければ書かない。** no-op な UPDATE が rows written に数えられるかは公式に記述が無い (research §5)
  if (changed === 0) {
    return 0;
  }

  const results = await db.batch(writes);
  if (guarded.some((i) => results[i]?.meta.changes !== 1)) {
    return "conflict";
  }
  return changed;
}

function bitsStatement(
  db: D1Database,
  uid: string,
  entry: Entry,
  bits: StoredBits,
  stored: StoredBits | undefined,
): D1PreparedStatement {
  if (stored === undefined) {
    return db
      .prepare(
        "INSERT INTO daybits (uid, ph, day, wbits, rbits) VALUES (?, ?, ?, ?, ?) ON CONFLICT (uid, ph, day) DO NOTHING",
      )
      .bind(uid, entry.ph, entry.day, bits.wbits, bits.rbits);
  }
  return db
    .prepare(
      "UPDATE daybits SET wbits = ?, rbits = ? WHERE uid = ? AND ph = ? AND day = ? AND wbits = ? AND rbits = ?",
    )
    .bind(bits.wbits, bits.rbits, uid, entry.ph, entry.day, stored.wbits, stored.rbits);
}

/**
 * daily の UPSERT。値は Worker で計算済みだが、**衝突したときに備えて SQL でも同じ規則で守る**
 * (`merge.ts`)。`DO UPDATE SET` の右辺の `daily.*` は更新前の値を指す。
 * 1 引数の `max(x)` は集約関数になるので、2 引数で書いてテーブル名で修飾する (research §5)。
 */
function dailyStatement(
  db: D1Database,
  uid: string,
  entry: Entry,
  daily: DailyValues,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO daily (uid, ph, day, w, r, pages, created, wc, wo, links) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (uid, ph, day) DO UPDATE SET
         w = max(daily.w, excluded.w),
         r = max(daily.w + daily.r, excluded.w + excluded.r) - max(daily.w, excluded.w),
         pages = max(daily.pages, excluded.pages),
         created = max(daily.created, excluded.created),
         wc = max(daily.wc, excluded.wc),
         wo = max(daily.wo, excluded.wo),
         links = max(daily.links, excluded.links)`,
    )
    .bind(
      uid,
      entry.ph,
      entry.day,
      daily.w,
      daily.r,
      daily.pages,
      daily.created,
      daily.wc,
      daily.wo,
      daily.links,
    );
}

/** D1 の BLOB を 180 バイトのビットマップにする。形が違えば throw (500 になる)。 */
function bitmapFrom(value: unknown): Bitmap {
  const bytes =
    value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : Array.isArray(value)
        ? Uint8Array.from(value, Number)
        : undefined;
  if (!bytes || !isBitmap(bytes)) {
    throw new TypeError("daybits のビットマップが 180 バイトでない");
  }
  return bytes;
}

function reject(status: 400 | 403 | 500, reason: Reason, entries?: number): Response {
  log(status, reason, entries, 0);
  return plainResponse(status);
}

/** Workers Logs に 1 行。**uid・ph・kid・日付・IP は出さない** (ADR-0013 決定 1)。 */
function log(status: number, reason: Reason, entries: number | undefined, changed: number): void {
  console.log(JSON.stringify({ event: "ingest", status, reason, entries, changed }));
}
