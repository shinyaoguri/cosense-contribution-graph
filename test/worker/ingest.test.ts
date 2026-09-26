import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { INGEST_PARAM } from "../../src/shared/beacon.ts";
import { bitmapOf, bitsEqual } from "../../src/shared/bits.ts";
import { PH_ALL, publicIdOf } from "../../src/shared/ids.ts";
import { handleIngest, REPLAY_WINDOW_SECONDS } from "../../src/worker/ingest.ts";
import type { ResolveKey } from "../../src/worker/keys.ts";
import {
  createSigner,
  entry,
  gifWidth,
  NOW,
  randomUid,
  type Signer,
  TODAY,
} from "./beacon-helpers.ts";

const PH_A = "0123456789abcdef";
const PH_B = "fedcba9876543210";

let signer: Signer;

beforeAll(async () => {
  signer = await createSigner();
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Options = {
  readonly db?: D1Database;
  readonly resolveKey?: ResolveKey;
  readonly now?: number;
};

function send(url: URL, options: Options = {}): Promise<Response> {
  return handleIngest(url, {
    db: options.db ?? env.DB,
    resolveKey: options.resolveKey ?? signer.resolveKey,
    now: () => options.now ?? NOW,
  });
}

type DailyRow = {
  w: number;
  r: number;
  pages: number;
  created: number;
  wc: number;
  wo: number;
  links: number;
};

async function dailyOf(uid: string, ph: string, day = TODAY): Promise<DailyRow | null> {
  return env.DB.prepare(
    "SELECT w, r, pages, created, wc, wo, links FROM daily WHERE uid = ? AND ph = ? AND day = ?",
  )
    .bind(uid, ph, day)
    .first<DailyRow>();
}

async function daybitsOf(uid: string, ph: string, day = TODAY) {
  const row = await env.DB.prepare(
    "SELECT wbits, rbits FROM daybits WHERE uid = ? AND ph = ? AND day = ?",
  )
    .bind(uid, ph, day)
    .first<{ wbits: ArrayBuffer; rbits: ArrayBuffer }>();
  return row && { wbits: new Uint8Array(row.wbits), rbits: new Uint8Array(row.rbits) };
}

/** batch の呼び出しを数える D1。`beforeWrite` は書き込みの batch の直前に走る (割り込みを再現する)。 */
function spyDb(beforeWrite?: () => Promise<void>) {
  const batches: number[] = [];
  const db = {
    prepare: (query: string) => env.DB.prepare(query),
    batch: async (statements: D1PreparedStatement[]) => {
      if (batches.length === 1 && beforeWrite) {
        await beforeWrite();
      }
      batches.push(statements.length);
      return env.DB.batch(statements);
    },
  } as unknown as D1Database;
  return { db, batches };
}

describe("GET /v1/p.gif — 記録する", () => {
  it("1 回目は 200 と幅 17 の GIF で、daily・daybits・graphs に書く", async () => {
    const uid = randomUid();
    const wbits = bitmapOf([600, 601, 602]);
    const rbits = bitmapOf([602, 603, 604, 605]);
    const res = await send(
      await signer.url(uid, [
        entry({ ph: PH_ALL, wbits, rbits, pages: 2, created: 1, wc: 1, wo: 2, links: 4 }),
      ]),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await gifWidth(res)).toBe(17);

    // r は r & ~w (602 は書きに数える)
    expect(await dailyOf(uid, PH_ALL)).toEqual({
      w: 3,
      r: 3,
      pages: 2,
      created: 1,
      wc: 1,
      wo: 2,
      links: 4,
    });
    const bits = await daybitsOf(uid, PH_ALL);
    expect(bits && bitsEqual(bits.wbits, wbits)).toBe(true);
    expect(bits && bitsEqual(bits.rbits, rbits)).toBe(true);

    const graph = await env.DB.prepare("SELECT uid, ph FROM graphs WHERE public_id = ?")
      .bind(await publicIdOf(uid, PH_ALL))
      .first();
    expect(graph).toEqual({ uid, ph: PH_ALL });
  });

  it("**同じビーコンを 2 回送っても値が変わらず、2 回目は幅 16 で書き込みの batch を送らない** (冪等)", async () => {
    const uid = randomUid();
    const url = await signer.url(uid, [
      entry({ wbits: bitmapOf([1, 2]), rbits: bitmapOf([3]), pages: 1 }),
      entry({ ph: PH_A, wbits: bitmapOf([1, 2]), rbits: bitmapOf([3]), pages: 1 }),
    ]);
    expect(await gifWidth(await send(url))).toBe(17);
    const before = [await dailyOf(uid, PH_ALL), await dailyOf(uid, PH_A)];

    const { db, batches } = spyDb();
    const second = await send(url, { db });

    expect(await gifWidth(second)).toBe(16);
    expect([await dailyOf(uid, PH_ALL), await dailyOf(uid, PH_A)]).toEqual(before);
    // 読みの batch だけ
    expect(batches).toHaveLength(1);
  });

  it("別の分を足して送ると OR でマージされる (順序に依らない)", async () => {
    const uid = randomUid();
    await send(await signer.url(uid, [entry({ wbits: bitmapOf([10, 11]) })]));
    const res = await send(await signer.url(uid, [entry({ wbits: bitmapOf([11, 12]) })]));

    expect(await gifWidth(res)).toBe(17);
    expect((await dailyOf(uid, PH_ALL))?.w).toBe(3);
  });

  it("**2 つのプロジェクトで同じ分に活動したとき、* 行の w が 2 にならず 1 になる** (二重計上の回帰)", async () => {
    const uid = randomUid();
    const same = bitmapOf([720]);
    // クライアントは * 行に全プロジェクトを OR したビットマップを送る (ADR-0007 決定 1)
    await send(
      await signer.url(uid, [
        entry({ ph: PH_A, wbits: same }),
        entry({ ph: PH_B, wbits: same }),
        entry({ ph: PH_ALL, wbits: same }),
      ]),
    );

    expect((await dailyOf(uid, PH_A))?.w).toBe(1);
    expect((await dailyOf(uid, PH_B))?.w).toBe(1);
    expect((await dailyOf(uid, PH_ALL))?.w).toBe(1);
  });

  it("**読みだった分が後から書きになると、r が減り合計は増えない** (w と r を別々に max で守ると二重に数える)", async () => {
    const uid = randomUid();
    await send(await signer.url(uid, [entry({ rbits: bitmapOf([100, 101]) })]));
    expect(await dailyOf(uid, PH_ALL)).toMatchObject({ w: 0, r: 2 });

    await send(await signer.url(uid, [entry({ wbits: bitmapOf([100]) })]));
    expect(await dailyOf(uid, PH_ALL)).toMatchObject({ w: 1, r: 1 });
  });

  it("**daybits が無い日に古いビーコンが来ても daily の w も合計も減らない**", async () => {
    const uid = randomUid();
    // Cron でビットマップだけ消えた状態 (受け付ける窓の中では普通は起きない)
    await env.DB.prepare(
      "INSERT INTO daily (uid, ph, day, w, r, pages, created, wc, wo, links) VALUES (?, ?, ?, 100, 50, 7, 2, 30, 20, 9)",
    )
      .bind(uid, PH_ALL, TODAY)
      .run();

    const res = await send(
      await signer.url(uid, [entry({ wbits: bitmapOf([1]), rbits: bitmapOf([2]), pages: 1 })]),
    );

    // ビットマップは新しく書くので「書いた」
    expect(await gifWidth(res)).toBe(17);
    expect(await dailyOf(uid, PH_ALL)).toEqual({
      w: 100,
      r: 50,
      pages: 7,
      created: 2,
      wc: 30,
      wo: 20,
      links: 9,
    });
  });

  it("pages / created の増加だけでも書き、減っても下げない", async () => {
    const uid = randomUid();
    const bits = { wbits: bitmapOf([5]) };
    await send(await signer.url(uid, [entry({ ...bits, pages: 1 })]));

    expect(await gifWidth(await send(await signer.url(uid, [entry({ ...bits, pages: 3 })])))).toBe(
      17,
    );
    expect(await gifWidth(await send(await signer.url(uid, [entry({ ...bits, pages: 2 })])))).toBe(
      16,
    );
    expect((await dailyOf(uid, PH_ALL))?.pages).toBe(3);
  });

  it("wc / wo / links の増加だけでも書き、減っても下げない", async () => {
    const uid = randomUid();
    const bits = { wbits: bitmapOf([5, 6]) };
    await send(await signer.url(uid, [entry({ ...bits, wc: 1 })]));

    expect(
      await gifWidth(await send(await signer.url(uid, [entry({ ...bits, wc: 1, wo: 1 })]))),
    ).toBe(17);
    expect(await gifWidth(await send(await signer.url(uid, [entry({ ...bits, links: 2 })])))).toBe(
      17,
    );
    expect(await gifWidth(await send(await signer.url(uid, [entry({ ...bits })])))).toBe(16);
    expect(await dailyOf(uid, PH_ALL)).toMatchObject({ wc: 1, wo: 1, links: 2 });
  });

  it("**v1 のビーコンも受け、作る・関わる・リンクは 0 として書く** (移行のため)", async () => {
    const uid = randomUid();
    const e = entry({ wbits: bitmapOf([7]), rbits: bitmapOf([8]), pages: 1 });
    const raw = [e.ph, e.day, encodeBase64url(e.wbits), encodeBase64url(e.rbits), "1", "0"].join(
      "|",
    );
    const res = await send(await signer.legacyUrl(uid, raw));

    expect(res.status).toBe(200);
    expect(await dailyOf(uid, PH_ALL)).toEqual({
      w: 1,
      r: 1,
      pages: 1,
      created: 0,
      wc: 0,
      wo: 0,
      links: 0,
    });
  });

  it("エントリの一部だけが変わったら、その分だけ書く", async () => {
    const uid = randomUid();
    await send(await signer.url(uid, [entry({ ph: PH_A, wbits: bitmapOf([1]) })]));

    const { db, batches } = spyDb();
    const res = await send(
      await signer.url(uid, [
        entry({ ph: PH_A, wbits: bitmapOf([1]) }),
        entry({ ph: PH_B, wbits: bitmapOf([1]) }),
      ]),
      { db },
    );

    expect(await gifWidth(res)).toBe(17);
    // 読み 3 文、書き 3 文 (PH_B の graphs・daybits・daily)
    expect(batches).toEqual([3, 3]);
  });
});

describe("GET /v1/p.gif — 同時に送られたとき", () => {
  it("**読んでから書くまでに別の送信がビットマップを書き換えたら、上書きせず 500** (ビットを失わない)", async () => {
    const uid = randomUid();
    await send(await signer.url(uid, [entry({ wbits: bitmapOf([1]) })]));

    const other = bitmapOf([1, 900]);
    const { db } = spyDb(async () => {
      await env.DB.prepare("UPDATE daybits SET wbits = ? WHERE uid = ? AND ph = ? AND day = ?")
        .bind(other, uid, PH_ALL, TODAY)
        .run();
    });
    const url = await signer.url(uid, [entry({ wbits: bitmapOf([1, 2]) })]);
    const res = await send(url, { db });

    expect(res.status).toBe(500);
    // 割り込んだ送信のビット (900) が残っている
    expect(bitsEqual((await daybitsOf(uid, PH_ALL))?.wbits ?? bitmapOf([]), other)).toBe(true);

    // クライアントが再送すると両方のビットがそろう
    expect(await gifWidth(await send(url))).toBe(17);
    expect(
      bitsEqual((await daybitsOf(uid, PH_ALL))?.wbits ?? bitmapOf([]), bitmapOf([1, 2, 900])),
    ).toBe(true);
    expect((await dailyOf(uid, PH_ALL))?.w).toBe(3);
  });

  it("**まだ無かった行を別の送信が先に作ったら、上書きせず 500**", async () => {
    const uid = randomUid();
    const other = bitmapOf([900]);
    const { db } = spyDb(async () => {
      await env.DB.prepare(
        "INSERT INTO daybits (uid, ph, day, wbits, rbits) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(uid, PH_ALL, TODAY, other, bitmapOf([]))
        .run();
    });
    const res = await send(await signer.url(uid, [entry({ wbits: bitmapOf([1]) })]), { db });

    expect(res.status).toBe(500);
    expect(bitsEqual((await daybitsOf(uid, PH_ALL))?.wbits ?? bitmapOf([]), other)).toBe(true);
  });

  it("D1 が throw したら 500 (text/plain)", async () => {
    const db = {
      prepare: (query: string) => env.DB.prepare(query),
      batch: async () => {
        throw new Error("D1_ERROR: exceeded the daily row write limit");
      },
    } as unknown as D1Database;
    const res = await send(await signer.url(randomUid(), [entry({ wbits: bitmapOf([1]) })]), {
      db,
    });

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("**鍵を引く段で D1 が throw しても 500** で、書き込みに進まない", async () => {
    const batch = vi.fn();
    const db = { batch } as unknown as D1Database;
    const res = await send(await signer.url(randomUid(), [entry({ wbits: bitmapOf([1]) })]), {
      db,
      resolveKey: async () => {
        throw new Error("D1_ERROR: network connection lost");
      },
    });

    expect(res.status).toBe(500);
    expect(batch).not.toHaveBeenCalled();
  });
});

describe("GET /v1/p.gif — 拒否する", () => {
  /** 形 (400) と窓 (400/403) の段では鍵も D1 も引かないことを見る。 */
  function untouched() {
    const resolveKey = vi.fn<ResolveKey>(async () => undefined);
    const db = {
      prepare: () => {
        throw new Error("D1 に触れた");
      },
      batch: () => {
        throw new Error("D1 に触れた");
      },
    } as unknown as D1Database;
    return { resolveKey, db };
  }

  it("**未来の日は 400。** 鍵も D1 も引かない", async () => {
    const deps = untouched();
    const res = await send(await signer.url(randomUid(), [entry({ day: "2026-09-15" })]), deps);

    expect(res.status).toBe(400);
    expect(deps.resolveKey).not.toHaveBeenCalled();
  });

  it("30 日より古い日は 400。窓の端の日は受け付ける", async () => {
    // NOW の UTC−12 の日付は 2026-09-13。その 30 日前が 2026-08-14
    expect((await send(await signer.url(randomUid(), [entry({ day: "2026-08-13" })]))).status).toBe(
      400,
    );
    expect((await send(await signer.url(randomUid(), [entry({ day: "2026-08-14" })]))).status).toBe(
      200,
    );
  });

  it("エントリが 1 つでも窓の外なら、全体を 400 にする", async () => {
    const res = await send(
      await signer.url(randomUid(), [entry(), entry({ ph: PH_A, day: "2026-09-16" })]),
    );
    expect(res.status).toBe(400);
  });

  it(`**署名した時刻がサーバ時刻から ±${REPLAY_WINDOW_SECONDS} 秒を超えたら 403**。ちょうどは受け付ける`, async () => {
    const at = async (offsetSeconds: number) =>
      (
        await send(
          await signer.url(
            randomUid(),
            [entry({ wbits: bitmapOf([1]) })],
            NOW / 1000 + offsetSeconds,
          ),
        )
      ).status;

    expect(await at(-REPLAY_WINDOW_SECONDS)).toBe(200);
    expect(await at(REPLAY_WINDOW_SECONDS)).toBe(200);
    expect(await at(-REPLAY_WINDOW_SECONDS - 1)).toBe(403);
    expect(await at(REPLAY_WINDOW_SECONDS + 1)).toBe(403);
  });

  it("**署名が 64 バイトでない (DER の長さ) なら 400** で、verify に渡さない", async () => {
    const deps = untouched();
    const url = await signer.url(randomUid(), [entry()]);
    url.searchParams.set(INGEST_PARAM.signature, encodeBase64url(new Uint8Array(71)));

    expect((await send(url, deps)).status).toBe(400);
    expect(deps.resolveKey).not.toHaveBeenCalled();
  });

  it("中身を書き換えたビーコンは 403 で、D1 に触れない", async () => {
    const uid = randomUid();
    const url = await signer.url(uid, [entry({ wbits: bitmapOf([1]) })]);
    const tampered = await signer.url(uid, [entry({ wbits: bitmapOf([1, 2, 3]) })]);
    // 別の中身に元の署名を付ける
    tampered.searchParams.set(
      INGEST_PARAM.signature,
      url.searchParams.get(INGEST_PARAM.signature) ?? "",
    );

    const { db } = untouched();
    expect((await send(tampered, { db })).status).toBe(403);
  });

  it("別の鍵の署名と、知らない kid は 403", async () => {
    const other = await createSigner();
    const url = await other.url(randomUid(), [entry()]);

    // kid が一致しない (鍵が見つからない)
    expect((await send(url)).status).toBe(403);
    // kid は一致したことにして、別の鍵で検証させる
    expect((await send(url, { resolveKey: () => signer.resolveKey("", signer.kid) })).status).toBe(
      403,
    );
  });

  it("不正な ph・重複キー・重複した (ph, day)・15 件・空の p・wc + wo の超過は 400", async () => {
    const uid = randomUid();
    const url = await signer.url(uid, [entry({ wbits: bitmapOf([1]) })]);
    const withEntries = (...ps: string[]) => {
      const copy = new URL(url);
      copy.searchParams.delete(INGEST_PARAM.entries);
      const sig = copy.searchParams.get(INGEST_PARAM.signature) ?? "";
      copy.searchParams.delete(INGEST_PARAM.signature);
      for (const p of ps) {
        copy.searchParams.append(INGEST_PARAM.entries, p);
      }
      copy.searchParams.set(INGEST_PARAM.signature, sig);
      return copy;
    };
    const p = url.searchParams.get(INGEST_PARAM.entries) ?? "";
    const withCounts = (wc: string, wo: string) =>
      p
        .split(".")
        .map((f, i) => (i === 6 ? wc : i === 7 ? wo : f))
        .join(".");

    expect((await send(withEntries(p.replace("*.", "ABCDEF0123456789.")))).status).toBe(400);
    expect((await send(withEntries(p, p))).status).toBe(400);
    expect((await send(withEntries(p, ""))).status).toBe(400);
    expect((await send(withEntries(...Array.from({ length: 15 }, () => p)))).status).toBe(400);
    // w は 1 分
    expect((await send(withEntries(withCounts("1", "1")))).status).toBe(400);

    const duplicated = new URL(url);
    duplicated.searchParams.append(INGEST_PARAM.uid, uid);
    expect((await send(duplicated)).status).toBe(400);
  });

  it("拒否は text/plain で no-store", async () => {
    const res = await send(new URL("https://example.com/v1/p.gif?v=1"));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /v1/p.gif — ログ", () => {
  it("**1 行だけ出し、uid・ph・kid・日付を出さない** (ADR-0013 決定 1)", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });
    const uid = randomUid();
    await send(await signer.url(uid, [entry({ ph: PH_A, wbits: bitmapOf([1]) })]));
    await send(await signer.url(uid, [entry({ ph: PH_A, day: "2026-09-20" })]));

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      event: "ingest",
      status: 200,
      reason: "written",
      entries: 1,
      changed: 1,
    });
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({ status: 400, reason: "day-window" });
    for (const line of lines) {
      expect(line).not.toContain(uid);
      expect(line).not.toContain(PH_A);
      expect(line).not.toContain(signer.kid);
      expect(line).not.toContain("2026-09");
    }
  });
});

describe("経路", () => {
  /** 経路を通すので時刻は本物。日付と署名の時刻を今に合わせる */
  async function liveUrl(uid: string) {
    const today = new Date().toISOString().slice(0, 10);
    return signer.url(uid, [entry({ day: today })], Math.floor(Date.now() / 1000));
  }

  it("**keys に登録した (uid, kid) の鍵なら 200**", async () => {
    const uid = randomUid();
    await env.DB.prepare("INSERT INTO keys (uid, kid, pubkey, created) VALUES (?, ?, ?, 0)")
      .bind(uid, signer.kid, signer.publicKey)
      .run();

    const res = await SELF.fetch((await liveUrl(uid)).href);
    expect(res.status).toBe(200);
  });

  it("**登録していない鍵は、署名が正しくても 403。** 別の uid に登録した鍵も使えない", async () => {
    const other = randomUid();
    await env.DB.prepare("INSERT INTO keys (uid, kid, pubkey, created) VALUES (?, ?, ?, 0)")
      .bind(other, signer.kid, signer.publicKey)
      .run();

    const res = await SELF.fetch((await liveUrl(randomUid())).href);
    expect(res.status).toBe(403);
  });

  it("**HEAD では書き込ませない** (404)", async () => {
    const url = await signer.url(randomUid(), [entry()]);
    const res = await SELF.fetch(url.href, { method: "HEAD" });
    expect(res.status).toBe(404);
  });

  it("形の違うクエリは 400", async () => {
    const res = await SELF.fetch("https://example.com/v1/p.gif?v=1&u=x");
    expect(res.status).toBe(400);
  });
});
