import { describe, expect, it } from "vitest";
import { decodeBase64url } from "../../src/shared/base64url.ts";
import { parseIngestQuery } from "../../src/shared/beacon.ts";
import { andNotBits, popcount } from "../../src/shared/bits.ts";
import { isValidUid, kidOf, PH_ALL, phOf, publicIdOf } from "../../src/shared/ids.ts";
import { importVerifyKey, verify } from "../../src/shared/sign.ts";
import type { ImageLike } from "../../src/userscript/image.ts";
import { WORKER_ORIGIN } from "../../src/userscript/probe.ts";
import {
  describeRecord,
  type KeyStore,
  type RecordResult,
  runRecord,
  sendRecord,
  TRIAL_UID_KEY,
} from "../../src/userscript/record.ts";

const PROJECT = "my-private-project";

/** 偽の鍵の置き場・localStorage・送信。送った URL を記録する。 */
function setup(result: RecordResult = { kind: "written" }) {
  let saved: CryptoKeyPair | undefined;
  let saves = 0;
  const keyStore: KeyStore = {
    load: async () => saved,
    save: async (pair) => {
      saved = pair;
      saves++;
    },
  };
  const store = new Map<string, string>();
  const urls: string[] = [];
  const deps = {
    keyStore,
    storage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
    now: () => new Date(2026, 8, 14, 12, 34, 56),
    send: async (url: string) => {
      urls.push(url);
      return result;
    },
  };
  return { deps, store, urls, saves: () => saves };
}

describe("runRecord", () => {
  it("**鍵と試験用の uid を作って保存し、署名したビーコンを本番の /v1/p.gif に送る**", async () => {
    const t = setup();

    const report = await runRecord(PROJECT, t.deps);

    expect(t.saves()).toBe(1);
    expect(report.createdKey).toBe(true);
    const uid = t.store.get(TRIAL_UID_KEY) ?? "";
    expect(isValidUid(uid)).toBe(true);

    expect(t.urls).toHaveLength(1);
    const url = new URL(t.urls[0] ?? "");
    expect(url.origin).toBe(WORKER_ORIGIN);
    expect(url.pathname).toBe("/v1/p.gif");

    const parsed = parseIngestQuery(url.searchParams);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.beacon.uid).toBe(uid);
    expect(parsed.beacon.time).toBe(Math.floor(new Date(2026, 8, 14, 12, 34, 56).getTime() / 1000));

    // 公開鍵と kid がダイアログの値と一致し、その鍵で署名が検証できる
    const publicKey = decodeBase64url(report.publicKey);
    if (!publicKey) throw new Error("公開鍵が base64url でない");
    expect(report.publicKey).toHaveLength(87);
    expect(await kidOf(publicKey)).toBe(report.kid);
    expect(parsed.beacon.kid).toBe(report.kid);
    const key = await importVerifyKey(publicKey);
    expect(await verify(key, parsed.beacon.signature, parsed.beacon.signingInput)).toBe(true);
  });

  it("**合算 (*) とこのプロジェクトの ph の 2 エントリで、今日の固定パターンを送る**", async () => {
    const t = setup();
    const report = await runRecord(PROJECT, t.deps);
    const uid = t.store.get(TRIAL_UID_KEY) ?? "";

    const parsed = parseIngestQuery(new URL(t.urls[0] ?? "").searchParams);
    if (!parsed.ok) throw new Error(parsed.reason);
    const [whole, project] = parsed.beacon.entries;

    expect(whole?.ph).toBe(PH_ALL);
    expect(project?.ph).toBe(await phOf(uid, PROJECT));
    for (const entry of parsed.beacon.entries) {
      expect(entry.day).toBe("2026-09-14");
      expect(report.day).toBe("2026-09-14");
      // 書き 5 分・読み 10 分 (同じ分の読みは書きに数える)。デッドゾーン 3 分を超える
      expect(popcount(entry.wbits)).toBe(5);
      expect(popcount(andNotBits(entry.rbits, entry.wbits))).toBe(10);
      expect(entry.pages).toBe(1);
      expect(entry.created).toBe(0);
    }
  });

  it("**送る日はローカルの日付** (日本時間の朝 8:30 は UTC ではまだ前日)", async () => {
    const t = setup();
    // テストを走らせるマシンのタイムゾーンに依らず、UTC+9 のローカル時刻を再現する
    const morningInTokyo = Object.assign(new Date("2026-09-13T23:30:00Z"), {
      getFullYear: () => 2026,
      getMonth: () => 8,
      getDate: () => 14,
    });
    const report = await runRecord(PROJECT, { ...t.deps, now: () => morningInTokyo });

    expect(report.day).toBe("2026-09-14");
    expect(new URL(t.urls[0] ?? "").searchParams.get("p")).toContain("|2026-09-14|");
  });

  it("**URL にプロジェクト名を載せない** (送るのは uid でソルトした ph だけ)", async () => {
    const t = setup();
    await runRecord(PROJECT, t.deps);

    expect(t.urls[0]).not.toContain(PROJECT);
    expect(decodeURIComponent(t.urls[0] ?? "")).not.toContain(PROJECT);
  });

  it("**2 回目は保存した鍵と uid を使い、同じ中身を送る** (Worker は 2 回目を「変化なし」にできる)", async () => {
    const t = setup();
    const first = await runRecord(PROJECT, t.deps);
    const second = await runRecord(PROJECT, t.deps);

    expect(t.saves()).toBe(1);
    expect(second.createdKey).toBe(false);
    expect(second.publicKey).toBe(first.publicKey);

    const entriesOf = (url: string) => new URL(url).searchParams.get("p");
    expect(entriesOf(t.urls[1] ?? "")).toBe(entriesOf(t.urls[0] ?? ""));
    expect(new URL(t.urls[1] ?? "").searchParams.get("u")).toBe(
      new URL(t.urls[0] ?? "").searchParams.get("u"),
    );
  });

  it("localStorage の uid の形が違えば作り直す", async () => {
    const t = setup();
    t.store.set(TRIAL_UID_KEY, "broken");

    await runRecord(PROJECT, t.deps);

    expect(isValidUid(t.store.get(TRIAL_UID_KEY) ?? "")).toBe(true);
  });

  it("合算とこのプロジェクトの共有 SVG の URL を返す", async () => {
    const t = setup();
    const report = await runRecord(PROJECT, t.deps);
    const uid = t.store.get(TRIAL_UID_KEY) ?? "";

    expect(report.wholeGraphUrl).toBe(`${WORKER_ORIGIN}/v1/g/${await publicIdOf(uid, PH_ALL)}.svg`);
    expect(report.projectGraphUrl).toBe(
      `${WORKER_ORIGIN}/v1/g/${await publicIdOf(uid, await phOf(uid, PROJECT))}.svg`,
    );
  });

  it("送信の結果をそのまま返す", async () => {
    const t = setup({ kind: "unchanged" });
    expect((await runRecord(PROJECT, t.deps)).result).toEqual({ kind: "unchanged" });
  });
});

describe("sendRecord", () => {
  function fakeImage(naturalWidth: number): ImageLike & { src: string } {
    return { naturalWidth, onload: null, onerror: null, referrerPolicy: "", src: "" };
  }

  async function sendWith(image: ImageLike, fire: "load" | "error") {
    const pending = sendRecord("https://example.com/v1/p.gif", { createImage: () => image });
    if (fire === "load") {
      image.onload?.();
    } else {
      image.onerror?.();
    }
    return pending;
  }

  it("幅 17 は書いた、16 は変化なし", async () => {
    expect(await sendWith(fakeImage(17), "load")).toEqual({ kind: "written" });
    expect(await sendWith(fakeImage(16), "load")).toEqual({ kind: "unchanged" });
  });

  it("**1×1 の画像は結果として読まない** (途中の何かが返した画像を取り違えない)", async () => {
    expect(await sendWith(fakeImage(1), "load")).toEqual({ kind: "unexpected", width: 1 });
  });

  it("画像として読めなければ error、応答が無ければ timeout", async () => {
    expect(await sendWith(fakeImage(0), "error")).toEqual({ kind: "error" });
    const image = fakeImage(0);
    expect(
      await sendRecord("https://example.com/v1/p.gif", { createImage: () => image, timeoutMs: 1 }),
    ).toEqual({
      kind: "timeout",
    });
  });

  it("referrerPolicy を no-referrer にしてから送る", async () => {
    const image = fakeImage(17);
    await sendWith(image, "load");
    expect(image.referrerPolicy).toBe("no-referrer");
    expect(image.src).toBe("https://example.com/v1/p.gif");
  });
});

describe("表示", () => {
  it("結果を 1 行の日本語にする", () => {
    expect(describeRecord({ kind: "written" })).toBe("書いた (幅 17)");
    expect(describeRecord({ kind: "unchanged" })).toContain("変化なし");
    expect(describeRecord({ kind: "error" })).toContain("鍵が未登録");
    expect(describeRecord({ kind: "timeout" })).toContain("15 秒");
    expect(describeRecord({ kind: "unexpected", width: 3 })).toContain("(3)");
  });
});
