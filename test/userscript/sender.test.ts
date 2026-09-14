import { describe, expect, it } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { parseIngestQuery } from "../../src/shared/beacon.ts";
import { kidOf, PH_ALL, phOf } from "../../src/shared/ids.ts";
import {
  exportPublicKey,
  generateSigningKeyPair,
  importVerifyKey,
  verify,
} from "../../src/shared/sign.ts";
import type { ImageResult } from "../../src/userscript/image.ts";
import type { DeviceRead } from "../../src/userscript/keys.ts";
import { readSent, SENT_KEY } from "../../src/userscript/outbox.ts";
import { backoffMs, createSender, MAX_TODAY_SENDS } from "../../src/userscript/sender.ts";
import { type Activity, createStore } from "../../src/userscript/store.ts";
import { localDay } from "../../src/userscript/time.ts";

const UID = encodeBase64url(new Uint8Array(20).fill(9));

/** ローカル時刻の 2026-09-15 12:00 */
const NOON = new Date(2026, 8, 15, 12, 0, 0).getTime();
const TODAY = localDay(new Date(NOON));
const YESTERDAY = localDay(new Date(NOON - 86_400_000));

async function device(uid = UID): Promise<DeviceRead> {
  const pair = await generateSigningKeyPair();
  const publicKey = await exportPublicKey(pair.publicKey);
  return {
    kind: "found",
    record: {
      v: 1,
      uid,
      kid: await kidOf(publicKey),
      privateKey: pair.privateKey,
      publicKey,
      enrolledAt: "2026-09-01T00:00:00Z",
    },
  };
}

async function harness(
  options: { device?: DeviceRead; image?: (url: string) => ImageResult } = {},
) {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
  const store = createStore(storage, () => undefined);
  const clock = { ms: NOON };
  const urls: string[] = [];
  const warnings: string[] = [];
  const state = {
    device: options.device ?? (await device()),
    image: options.image ?? (() => ({ kind: "loaded", width: 17 }) as ImageResult),
    keyReads: 0,
  };
  // 本物のロックの代わりに直列のキュー
  let queue: Promise<unknown> = Promise.resolve();
  const withLock = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run);
    queue = next.catch(() => undefined);
    return next;
  };
  const deps = {
    store,
    keys: {
      read: async () => {
        state.keyReads++;
        return state.device;
      },
    },
    sendImage: async (url: string) => {
      urls.push(url);
      return state.image(url);
    },
    storage,
    now: () => new Date(clock.ms),
    withLock,
    warn: (message: string) => warnings.push(message),
  };
  const record = (activity: Activity) => store.record(activity);
  return { deps, sender: createSender(deps), store, record, map, clock, urls, warnings, state };
}

function decoded(url: string) {
  const parsed = parseIngestQuery(new URL(url).searchParams);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  return parsed.beacon;
}

describe("createSender — 読み込み時", () => {
  it("**前日以前の未送信の日だけを送り、今日は送らない**。登録した鍵の署名を検証できる", async () => {
    const t = await harness();
    t.record({ kind: "write", project: "project-a", day: YESTERDAY, minute: 600 });
    t.record({ kind: "write", project: "project-a", day: TODAY, minute: 600 });

    expect(await t.sender.trigger("load")).toBe("written");
    expect(t.urls).toHaveLength(1);
    const beacon = decoded(t.urls[0] ?? "");
    expect(new Set(beacon.entries.map((e) => e.day))).toEqual(new Set([YESTERDAY]));
    expect(beacon.entries.map((e) => e.ph).sort()).toEqual(
      [await phOf(UID, "project-a"), PH_ALL].sort(),
    );
    expect(beacon.uid).toBe(UID);
    const found = t.state.device;
    if (found.kind !== "found") throw new Error();
    expect(beacon.kid).toBe(found.record.kid);
    expect(
      await verify(
        await importVerifyKey(found.record.publicKey),
        beacon.signature,
        beacon.signingInput,
      ),
    ).toBe(true);
    expect(beacon.time).toBe(Math.floor(NOON / 1000));
  });

  it("**2 回目は送らない** (送れた中身を覚えている)", async () => {
    const t = await harness();
    t.record({ kind: "read", project: "p", day: YESTERDAY, minute: 1 });
    await t.sender.trigger("load");
    expect(await t.sender.trigger("load")).toBe("nothing");
    expect(t.urls).toHaveLength(1);
  });

  it("中身が変わった日は、変わったエントリだけを送り直す", async () => {
    const t = await harness();
    t.record({ kind: "read", project: "a", day: YESTERDAY, minute: 1 });
    t.record({ kind: "read", project: "b", day: YESTERDAY, minute: 1 });
    await t.sender.trigger("load");
    t.record({ kind: "read", project: "b", day: YESTERDAY, minute: 2 });

    await t.sender.trigger("load");
    const beacon = decoded(t.urls[1] ?? "");
    expect(beacon.entries.map((e) => e.ph).sort()).toEqual([await phOf(UID, "b"), PH_ALL].sort());
  });

  it("**16 (変化なし) も送信済みにする**", async () => {
    const t = await harness({ image: () => ({ kind: "loaded", width: 16 }) });
    t.record({ kind: "read", project: "p", day: YESTERDAY, minute: 1 });
    expect(await t.sender.trigger("load")).toBe("unchanged");
    expect(await t.sender.trigger("load")).toBe("nothing");
  });

  it.each([
    ["画像にならない", { kind: "error" } as ImageResult, "error"],
    ["応答が無い", { kind: "timeout" } as ImageResult, "timeout"],
    ["幅が想定外", { kind: "loaded", width: 1 } as ImageResult, "unexpected"],
  ])("**%s なら送信済みにせず、抑制の後に送り直す**", async (_, image, outcome) => {
    const t = await harness({ image: () => image });
    t.record({ kind: "read", project: "p", day: YESTERDAY, minute: 1 });

    expect(await t.sender.trigger("load")).toBe(outcome);
    expect(await t.sender.trigger("load")).toBe("backoff");
    expect(t.urls).toHaveLength(1);

    t.state.image = () => ({ kind: "loaded", width: 17 });
    t.clock.ms += backoffMs(1);
    expect(await t.sender.trigger("load")).toBe("written");
    const sent = readSent(t.deps.storage);
    expect(sent !== "newer" && sent.failure).toBeUndefined();
  });

  it("失敗したら残りのリクエストを送らない", async () => {
    const t = await harness({ image: () => ({ kind: "error" }) });
    // 15 日分 × 2 行 = 30 エントリで 3 リクエストに分かれる
    for (let i = 1; i <= 15; i++) {
      t.record({
        kind: "read",
        project: "p",
        day: localDay(new Date(NOON - i * 86_400_000)),
        minute: 1,
      });
    }
    await t.sender.trigger("load");
    expect(t.urls).toHaveLength(1);
  });

  it("抑制は失敗が続くほど長くなり、24 時間で頭打ち", () => {
    expect(backoffMs(1)).toBe(15 * 60_000);
    expect(backoffMs(2)).toBe(30 * 60_000);
    expect(backoffMs(20)).toBe(24 * 60 * 60_000);
  });
});

describe("createSender — タブを隠したとき", () => {
  it("**今日を送る。変化が無ければ送らず、回数も増えない**", async () => {
    const t = await harness();
    t.record({ kind: "write", project: "p", day: TODAY, minute: 700 });

    expect(await t.sender.trigger("hidden")).toBe("written");
    expect(await t.sender.trigger("hidden")).toBe("nothing");
    expect(t.urls).toHaveLength(1);
    const sent = readSent(t.deps.storage);
    expect(sent !== "newer" && sent.days[TODAY]?.n).toBe(1);
  });

  it(`**当日分は ${MAX_TODAY_SENDS} 回まで。失敗も数える**`, async () => {
    const t = await harness({ image: () => ({ kind: "error" }) });
    for (let i = 0; i < MAX_TODAY_SENDS; i++) {
      t.record({ kind: "read", project: "p", day: TODAY, minute: i });
      await t.sender.trigger("enrolled"); // 抑制を効かせずに数える
    }
    t.record({ kind: "read", project: "p", day: TODAY, minute: 99 });
    expect(await t.sender.trigger("enrolled")).toBe("limited");
    expect(t.urls).toHaveLength(MAX_TODAY_SENDS);
  });

  it("上限に達しても、過去日は送る", async () => {
    const t = await harness();
    for (let i = 0; i < MAX_TODAY_SENDS; i++) {
      t.record({ kind: "read", project: "p", day: TODAY, minute: i });
      await t.sender.trigger("hidden");
    }
    t.record({ kind: "read", project: "p", day: TODAY, minute: 99 });
    t.record({ kind: "read", project: "p", day: YESTERDAY, minute: 1 });
    expect(await t.sender.trigger("hidden")).toBe("written");
    const beacon = decoded(t.urls.at(-1) ?? "");
    expect(new Set(beacon.entries.map((e) => e.day))).toEqual(new Set([YESTERDAY]));
  });
});

describe("createSender — 鍵と状態", () => {
  it.each([
    ["未登録", { kind: "missing" } as DeviceRead, "not-enrolled"],
    ["形が違う", { kind: "invalid" } as DeviceRead, "not-enrolled"],
    ["新しい版の鍵", { kind: "newer" } as DeviceRead, "newer-key"],
  ])("**%s なら 1 本も送らない**", async (_, value, outcome) => {
    const t = await harness({ device: value });
    t.record({ kind: "read", project: "p", day: YESTERDAY, minute: 1 });
    expect(await t.sender.trigger("load")).toBe(outcome);
    expect(t.urls).toHaveLength(0);
  });

  it("未登録の知らせは読み込みごとに 1 回", async () => {
    const t = await harness({ device: { kind: "missing" } });
    await t.sender.trigger("load");
    await t.sender.trigger("hidden");
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toContain("サインインしてこの端末を登録");
  });

  it("**鍵はきっかけのたびに読み直す** (別のタブで登録した鍵を拾う)", async () => {
    const t = await harness({ device: { kind: "missing" } });
    t.record({ kind: "read", project: "p", day: YESTERDAY, minute: 1 });
    expect(await t.sender.trigger("load")).toBe("not-enrolled");
    t.state.device = await device();
    expect(await t.sender.trigger("hidden")).toBe("written");
    expect(t.state.keyReads).toBe(2);
  });

  it("署名できない鍵なら key-unusable で送らない", async () => {
    const found = await device();
    if (found.kind !== "found") throw new Error();
    const broken: DeviceRead = {
      kind: "found",
      record: { ...found.record, privateKey: found.record.publicKey as unknown as CryptoKey },
    };
    const t = await harness({ device: broken });
    t.record({ kind: "read", project: "p", day: YESTERDAY, minute: 1 });
    expect(await t.sender.trigger("load")).toBe("key-unusable");
    expect(t.urls).toHaveLength(0);
  });

  it("**登録の成功なら抑制中でも送る**", async () => {
    const t = await harness({ image: () => ({ kind: "error" }) });
    t.record({ kind: "read", project: "p", day: YESTERDAY, minute: 1 });
    await t.sender.trigger("load");
    t.state.image = () => ({ kind: "loaded", width: 17 });
    expect(await t.sender.trigger("hidden")).toBe("backoff");
    expect(await t.sender.trigger("enrolled")).toBe("written");
  });

  it("別のアカウントに入り直したら、同じ中身も送り直す", async () => {
    const t = await harness();
    t.record({ kind: "read", project: "p", day: YESTERDAY, minute: 1 });
    await t.sender.trigger("load");
    t.state.device = await device(encodeBase64url(new Uint8Array(20).fill(1)));
    expect(await t.sender.trigger("load")).toBe("written");
  });

  it("送信済みの記録が知らない版なら送らない", async () => {
    const t = await harness();
    t.map.set(SENT_KEY, JSON.stringify({ v: 2, days: {} }));
    t.record({ kind: "read", project: "p", day: YESTERDAY, minute: 1 });
    expect(await t.sender.trigger("load")).toBe("newer-sent");
    expect(t.urls).toHaveLength(0);
  });

  it("**2 つのタブが同時に送っても、同じ中身は 1 回** (ロックの中で送信済みを読み直す)", async () => {
    const t = await harness();
    const other = createSender(t.deps);
    t.record({ kind: "read", project: "p", day: YESTERDAY, minute: 1 });
    const results = await Promise.all([t.sender.trigger("load"), other.trigger("load")]);
    expect(results.sort()).toEqual(["nothing", "written"]);
    expect(t.urls).toHaveLength(1);
  });

  it("**ログと送信済みの記録に uid・ph・プロジェクト名・URL を残さない**", async () => {
    const t = await harness({ device: { kind: "missing" } });
    await t.sender.trigger("load");
    t.state.device = await device();
    t.record({ kind: "read", project: "secret-project", day: YESTERDAY, minute: 1 });
    await t.sender.trigger("load");

    const stored = t.map.get(SENT_KEY) ?? "";
    const text = [...t.warnings, stored].join("\n");
    for (const secret of [UID, await phOf(UID, "secret-project"), "secret-project", "p.gif"]) {
      expect(text).not.toContain(secret);
    }
    expect(stored).toContain('"outcome":"written"');
  });
});

describe("createSender — status", () => {
  it("未登録なら not-enrolled", async () => {
    const t = await harness({ device: { kind: "missing" } });
    expect(await t.sender.status()).toEqual({ kind: "not-enrolled" });
  });

  it("**登録済みなら kid・合算の草の URL・今日の回数・未送信の日数・最後の送信を返す**", async () => {
    const t = await harness();
    t.record({ kind: "read", project: "p", day: YESTERDAY, minute: 1 });
    t.record({ kind: "read", project: "p", day: TODAY, minute: 1 });
    const before = await t.sender.status();
    expect(before.kind === "enrolled" && before.pendingDays).toBe(2);

    await t.sender.trigger("hidden");
    const after = await t.sender.status();
    if (after.kind !== "enrolled") throw new Error(after.kind);
    const found = t.state.device;
    if (found.kind !== "found") throw new Error();
    expect(after.kid).toBe(found.record.kid);
    expect(after.graphUrl).toMatch(/^https:\/\/grass\.soui\.dev\/v1\/g\/[0-9a-f]{32}\.svg$/);
    expect(after.pendingDays).toBe(0);
    expect(after.todaySends).toBe(1);
    expect(after.last).toMatchObject({
      trigger: "hidden",
      outcome: "written",
      requests: 1,
      entries: 4,
    });
    expect(after.backoffUntil).toBeUndefined();
  });

  it("抑制中なら次に送る時刻を返し、過ぎたら返さない", async () => {
    const t = await harness({ image: () => ({ kind: "error" }) });
    t.record({ kind: "read", project: "p", day: YESTERDAY, minute: 1 });
    await t.sender.trigger("load");
    const status = await t.sender.status();
    expect(status.kind === "enrolled" && status.backoffUntil).toBe(NOON + backoffMs(1));
    t.clock.ms += backoffMs(1);
    const later = await t.sender.status();
    expect(later.kind === "enrolled" && later.backoffUntil).toBeUndefined();
  });
});
