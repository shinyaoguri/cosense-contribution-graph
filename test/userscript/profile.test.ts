import { describe, expect, it } from "vitest";
import { encodeBase64url } from "../../src/shared/base64url.ts";
import { UID_BYTES } from "../../src/shared/ids.ts";
import type { CommitResult } from "../../src/userscript/cosense-socket.ts";
import type { DeviceRead } from "../../src/userscript/keys.ts";
import {
  buildCommit,
  createProfileCard,
  END,
  hasCardLine,
  insertionPoint,
  MAX_ATTEMPTS,
  newLineId,
  type PageCommit,
  type PageLine,
  type ProfilePage,
  parsePage,
} from "../../src/userscript/profile.ts";
import { cardLine, cardUrl, graphIds } from "../../src/userscript/worker-origin.ts";

const UID = encodeBase64url(new Uint8Array(UID_BYTES).fill(7));
const USER_ID = "5f0123456789abcdef654321";
const PROJECT_ID = "5f00000000000000000000aa";
const IMPORT = ' import "/api/code/cosense-grass/v1/script.js"';

const linesOf = (texts: readonly string[]): PageLine[] =>
  texts.map((text, i) => ({ id: `L${i}`, text }));

function pageOf(texts: readonly string[], over: Partial<ProfilePage> = {}): ProfilePage {
  return {
    id: "page-1",
    commitId: "commit-1",
    persistent: true,
    image: null,
    descriptions: [],
    lines: linesOf(texts),
    ...over,
  };
}

/** よくあるプロフィールページ: 自己紹介の後に import のコードブロック、その後にも本文 */
const PROFILE = ["alice", "自己紹介です", "code:script.js", IMPORT, "", "ほかの話"];

/**
 * 行ごとのまとまりの種類。**`@progfay/scrapbox-parser` の `block/Pack.ts` の規則を、テストの側で独立に書いたもの**
 * (`code:` / `table:` で始まる行から、それより深く字下げされた行が続く間がブロック)
 */
function kindsOf(texts: readonly string[]): string[] {
  const kinds = ["title"];
  let block: { kind: "code" | "table"; indent: number } | undefined;
  for (const text of texts.slice(1)) {
    const indent = /^\s+/.exec(text)?.[0].length ?? 0;
    if (block !== undefined && indent > block.indent) {
      kinds.push(`${block.kind}-body`);
      continue;
    }
    const kind = /^\s*code:/.test(text) ? "code" : /^\s*table:/.test(text) ? "table" : undefined;
    block = kind === undefined ? undefined : { kind, indent };
    kinds.push(kind === undefined ? "line" : `${kind}-start`);
  }
  return kinds;
}

/** commit の `_insert` をページに当てた後の行 */
function applied(page: ProfilePage, commit: PageCommit): string[] {
  const [insert] = commit.changes;
  const texts = page.lines.map((line) => line.text);
  const at =
    insert._insert === END
      ? texts.length
      : page.lines.findIndex((line) => line.id === insert._insert);
  expect(at).toBeGreaterThan(0);
  return [...texts.slice(0, at), insert.lines.text, ...texts.slice(at)];
}

describe("hasCardLine", () => {
  it("**そのプロジェクトの publicId の card.svg があれば「ある」。オリジン・クエリ・前後の文字は問わない**", async () => {
    const { publicId } = await graphIds(UID, "p");
    for (const text of [
      cardLine(publicId, { project: "p", user: "alice" }),
      `[https://cosense-grass.soui.workers.dev/v1/g/${publicId}/card.svg]`,
      `> 私のカード [https://grass.soui.dev/v1/g/${publicId}/card.svg?l=p&theme=dark] です`,
    ]) {
      expect(hasCardLine(linesOf(["alice", text]), publicId)).toBe(true);
    }
  });

  it("**ほかのプロジェクト・合算のカードや、草と概観の URL では「無い」**", async () => {
    const own = await graphIds(UID, "p");
    const other = await graphIds(UID, "q");
    const total = await graphIds(UID);
    const lines = linesOf([
      "alice",
      cardLine(other.publicId, { project: "q" }),
      cardLine(total.publicId),
      `[https://grass.soui.dev/v1/g/${own.publicId}.svg?l=p]`,
      `[https://grass.soui.dev/v1/g/${own.publicId}/overview.svg]`,
    ]);

    expect(hasCardLine(lines, own.publicId)).toBe(false);
  });
});

describe("insertionPoint", () => {
  it("**cosense-grass を読み込むコードブロックの最後の行の次の行の前に入れる**", () => {
    expect(insertionPoint(linesOf(PROFILE))).toEqual({ before: "L4", index: 4 });
  });

  it("**ブロックがページの末尾なら `_end`**", () => {
    expect(insertionPoint(linesOf(["alice", "自己紹介", "code:script.js", IMPORT]))).toEqual({
      before: END,
      index: 4,
    });
  });

  it("**ブロックが無ければ末尾**", () => {
    expect(insertionPoint(linesOf(["alice", "自己紹介", "[alice.icon]"]))).toEqual({
      before: END,
      index: 3,
    });
  });

  it("**cosense-grass を読み込まないコードブロックとテーブルは無視する**", () => {
    const lines = linesOf([
      "alice",
      "code:script.js",
      " console.log(1)",
      "table:links",
      " /api/code/cosense-grass/ の説明",
      "本文",
      "code:script.js",
      ' import "/api/code/other/x/script.js"',
      IMPORT,
      "  // 深い字下げもブロックの続き",
      "後ろ",
    ]);

    expect(insertionPoint(lines)).toEqual({ before: "L10", index: 10 });
  });

  it("**字下げしたコードブロックは、同じ深さの行で終わる**", () => {
    const lines = linesOf([
      "alice",
      "UserScript",
      " code:script.js",
      `  ${IMPORT.trim()}`,
      " 同じ深さの行",
    ]);

    expect(insertionPoint(lines)).toEqual({ before: "L4", index: 4 });
  });

  it("**タイトルの直後 (最上部) には入れない。** タイトルだけのページでは足さない", () => {
    expect(insertionPoint(linesOf(["alice"]))).toBeUndefined();
    // タイトルが code: で始まってもブロックにしない (タイトル行はまとまりに入らない)
    expect(insertionPoint(linesOf(["code:script.js", IMPORT]))).toEqual({
      before: END,
      index: 2,
    });
  });
});

describe("newLineId", () => {
  it("**`@cosense/std` の createNewLineId と同じ形** (秒 8 桁 + userId の末尾 6 桁 + 0000 + 乱数 8 桁)", () => {
    const now = new Date("2026-10-07T00:00:00Z");

    expect(newLineId(USER_ID, now, () => 0)).toBe(
      `${(1_791_331_200).toString(16)}654321000000000000`,
    );
    expect(newLineId(USER_ID, now, () => 0.5)).toBe(
      `${(1_791_331_200).toString(16)}6543210000${Math.floor(0xfffffe * 0.5)
        .toString(16)
        .padStart(8, "0")}`,
    );
    expect(newLineId(USER_ID, now, Math.random)).toMatch(/^[0-9a-f]{26}$/);
  });
});

describe("buildCommit", () => {
  const TEXT = "[https://grass.soui.dev/v1/g/0123/card.svg?l=p https://scrapbox.io/p/]";
  const SRC = "https://grass.soui.dev/v1/g/0123/card.svg?l=p";
  const build = (page: ProfilePage) => {
    const point = insertionPoint(page.lines);
    if (point === undefined) throw new Error("位置が無い");
    return buildCommit({
      page,
      point,
      text: TEXT,
      src: SRC,
      lineId: "line-new",
      userId: USER_ID,
      projectId: PROJECT_ID,
    });
  };

  it("**本体と同じ形の commit。親は読んだときの最新の commit**", () => {
    const page = pageOf(PROFILE, { descriptions: ["自己紹介です", "`x`", "ほかの話"] });

    const commit = build(page);

    expect(commit).toMatchObject({
      kind: "page",
      parentId: "commit-1",
      cursor: null,
      pageId: "page-1",
      userId: USER_ID,
      projectId: PROJECT_ID,
      freeze: true,
    });
    expect(commit.changes[0]).toEqual({ _insert: "L4", lines: { id: "line-new", text: TEXT } });
  });

  it("**linesCount と charsCount は足した後の値** (文字数はタイトルも含めてコードポイントで数える)", () => {
    const page = pageOf(["alice", "😀 絵文字", "code:script.js", IMPORT]);

    const commit = build(page);

    const texts = [...page.lines.map((line) => line.text), TEXT];
    expect(commit.changes).toContainEqual({ linesCount: 5 });
    expect(commit.changes).toContainEqual({
      charsCount: texts.reduce((sum, text) => sum + [...text].length, 0),
    });
    // 最後の 2 つは必ず linesCount と charsCount (makeChanges.ts と同じ順)
    expect(commit.changes.slice(-2).map((change) => Object.keys(change)[0])).toEqual([
      "linesCount",
      "charsCount",
    ]);
  });

  it("**画像の無いページでは、カードの図がページの画像になる**", () => {
    expect(build(pageOf(PROFILE)).changes).toContainEqual({ image: SRC });
  });

  it("**今の画像の行が足す位置より前にあれば、画像は変えない**", () => {
    const page = pageOf(
      ["alice", "[https://gyazo.com/0123456789abcdef0123456789abcdef]", ...PROFILE.slice(1)],
      {
        image: "https://gyazo.com/0123456789abcdef0123456789abcdef/raw",
      },
    );

    expect(build(page).changes.some((change) => "image" in change)).toBe(false);
  });

  it("**今の画像の行が足す位置より後ろにあれば、カードの図が最初の画像になる**", () => {
    const page = pageOf([...PROFILE, "[https://scrapbox.io/files/0123456789abcdef01234567.png]"], {
      image: "https://scrapbox.io/files/0123456789abcdef01234567.png",
    });

    expect(build(page).changes).toContainEqual({ image: SRC });
  });

  it("**今の画像の行が見つからなければ変えない** (誤ってサムネを差し替えない。コードブロックの中は数えない)", () => {
    const page = pageOf(["alice", "code:memo", " https://example.com/a.png", ...PROFILE.slice(1)], {
      image: "https://example.com/a.png",
    });

    expect(build(page).changes.some((change) => "image" in change)).toBe(false);
  });

  it("**説明が 5 つに満たなければ、足す位置の順番に入れる**", () => {
    // 前に「自己紹介です」とコードブロックの 2 つ、後ろに「ほかの話」
    const page = pageOf(PROFILE, {
      descriptions: ["自己紹介です", '`import "/api/code/cosense-grass/v1/script.js"`', "ほかの話"],
    });

    expect(build(page).changes).toContainEqual({
      descriptions: [
        "自己紹介です",
        '`import "/api/code/cosense-grass/v1/script.js"`',
        TEXT,
        "ほかの話",
      ],
    });
    // コードブロックのすぐ後ろの行は、足した行より後ろに回る
    const adjacent = pageOf(["alice", "code:script.js", IMPORT, "すぐ後ろ"], {
      descriptions: ["`import`", "すぐ後ろ"],
    });
    expect(build(adjacent).changes).toContainEqual({
      descriptions: ["`import`", TEXT, "すぐ後ろ"],
    });
  });

  it("**前に説明が 5 つあれば変えない。空行とテーブルは数えない**", () => {
    const five = pageOf(
      ["alice", "1", "2", "", "3", "table:t", " a\tb", "4", ...PROFILE.slice(2)],
      {
        descriptions: ["1", "2", "3", "4", "`import`"],
      },
    );
    expect(build(five).changes.some((change) => "descriptions" in change)).toBe(false);

    const four = pageOf(["alice", "1", "", "table:t", " a\tb", "3", ...PROFILE.slice(2)], {
      descriptions: ["1", "3", "`import`", "ほかの話"],
    });
    expect(build(four).changes).toContainEqual({
      descriptions: ["1", "3", "`import`", TEXT, "ほかの話"],
    });
  });

  describe("不変条件 (ADR-0025 決定 3)", () => {
    const pages = [
      pageOf(PROFILE),
      pageOf(["alice", "自己紹介", "code:script.js", IMPORT]),
      pageOf(["alice", " code:script.js", `  ${IMPORT.trim()}`, "   深い行", " 同じ深さ", "末尾"]),
      pageOf([
        "alice",
        "code:a.js",
        " x",
        "table:t",
        " y",
        "code:script.js",
        IMPORT,
        "code:b.js",
        " z",
      ]),
      pageOf(["alice", "コードブロックが無い", "code:other.js", " 末尾がほかのコードブロック"]),
      pageOf(["alice", "code:script.js", IMPORT, "\t\tタブで字下げした行"]),
    ];

    it("**変更は `_insert` 1 つとメタデータだけ。`_update` と `_delete` を含めない**", () => {
      for (const page of pages) {
        const changes = build(page).changes;
        const lineChanges = changes.flatMap((change) =>
          Object.keys(change).filter((key) => key.startsWith("_")),
        );
        expect(lineChanges).toEqual(["_insert"]);
        expect(JSON.stringify(changes)).not.toMatch(/"_(update|delete)"/);
        for (const change of changes.slice(1)) {
          expect(Object.keys(change)).toHaveLength(1);
          expect(["image", "descriptions", "linesCount", "charsCount"]).toContain(
            Object.keys(change)[0],
          );
        }
      }
    });

    it("**足した行はどのコードブロックにも入らず、ほかの行のまとまりも変えない**", () => {
      for (const page of pages) {
        const commit = build(page);
        const before = kindsOf(page.lines.map((line) => line.text));
        const after = applied(page, commit);
        const at = after.indexOf(TEXT);
        const kinds = kindsOf(after);

        // 字下げせず、それだけで 1 つの行になる
        expect(TEXT).toMatch(/^\S/);
        expect(kinds[at]).toBe("line");
        // 足した行の前後で、元の行の種類が変わらない (コードブロックが切れたり伸びたりしない)
        expect([...kinds.slice(0, at), ...kinds.slice(at + 1)]).toEqual(before);
        // タイトルの直後には入れない
        expect(at).toBeGreaterThan(1);
      }
    });
  });
});

describe("parsePage", () => {
  it("REST の応答から使うものだけを読む。形が違えば undefined", () => {
    const body = JSON.stringify({
      id: "page-1",
      commitId: "commit-1",
      persistent: true,
      image: null,
      descriptions: ["a"],
      lines: [{ id: "L0", text: "alice", userId: "u", created: 1 }],
      relatedPages: {},
    });
    expect(parsePage(body)).toEqual(pageOf(["alice"], { descriptions: ["a"] }));
    expect(parsePage("{}")).toBeUndefined();
    expect(parsePage("<html>")).toBeUndefined();
    expect(
      parsePage(JSON.stringify({ id: "p", commitId: "c", lines: [{ id: 1 }] })),
    ).toBeUndefined();
    expect(
      parsePage(JSON.stringify({ id: "p", commitId: "c", lines: [], persistent: false }))
        ?.persistent,
    ).toBe(false);
  });
});

/** ensure の偽の環境。ページの応答は読むたびに次のものを返す (最後のものを使い続ける) */
async function harness(options: { pages?: (string | undefined)[]; project?: string } = {}) {
  const project = options.project ?? "p";
  const state = {
    device: { kind: "found", record: { uid: UID } } as unknown as DeviceRead,
    user: "alice" as string | undefined,
    pages: options.pages ?? [JSON.stringify({ ...pageOf(PROFILE), lines: linesOf(PROFILE) })],
    results: [{ kind: "committed", commitId: "commit-2" }] as CommitResult[],
    fetchError: false,
  };
  const fetched: string[] = [];
  const commits: PageCommit[] = [];
  const locks: string[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  let pageReads = 0;
  const card = createProfileCard({
    keys: { read: async () => state.device },
    userName: () => state.user,
    fetchText: async (path) => {
      fetched.push(path);
      if (state.fetchError) {
        throw new TypeError("Failed to fetch");
      }
      if (path === "/api/users/me") return JSON.stringify({ id: USER_ID, name: "alice" });
      if (path === `/api/projects/${project}`) return JSON.stringify({ id: PROJECT_ID });
      if (path === `/api/pages/${project}/alice`) {
        const body = state.pages[Math.min(pageReads, state.pages.length - 1)];
        pageReads++;
        return body;
      }
      return undefined;
    },
    sendCommit: async (commit) => {
      commits.push(commit);
      return (
        state.results[Math.min(commits.length - 1, state.results.length - 1)] ?? {
          kind: "failed",
          reason: "closed",
        }
      );
    },
    withLock: async (name, run) => {
      locks.push(name);
      return run();
    },
    now: () => new Date("2026-10-07T00:00:00Z"),
    random: () => 0.25,
    log: (message) => logs.push(message),
    warn: (message) => warnings.push(message),
  });
  const { publicId } = await graphIds(UID, project);
  const pageBody = (texts: readonly string[]) =>
    JSON.stringify({ ...pageOf(texts), lines: linesOf(texts) });
  return { card, state, fetched, commits, locks, logs, warnings, publicId, pageBody, project };
}

describe("createProfileCard — ensure", () => {
  it("**無ければ、読み込みのコードブロックの直後に 1 行貼る** (自分の id とプロジェクトの id を引き、ロックの中で送る)", async () => {
    const t = await harness();

    expect(await t.card.ensure("p")).toBe("inserted");

    expect(t.commits).toHaveLength(1);
    const commit = t.commits[0];
    expect(commit?.userId).toBe(USER_ID);
    expect(commit?.projectId).toBe(PROJECT_ID);
    expect(commit?.changes[0]).toEqual({
      _insert: "L4",
      lines: {
        id: newLineId(USER_ID, new Date("2026-10-07T00:00:00Z"), () => 0.25),
        text: cardLine(t.publicId, { project: "p", user: "alice" }),
      },
    });
    expect(commit?.changes).toContainEqual({
      image: cardUrl(t.publicId, { project: "p", user: "alice" }),
    });
    expect(t.locks).toEqual(["cosense-grass:profile:p"]);
    expect(t.fetched).toEqual(["/api/pages/p/alice", "/api/users/me", "/api/projects/p"]);
    expect(t.logs).toEqual(["プロフィールページにカードの図を貼りました"]);
    expect(t.warnings).toEqual([]);
  });

  describe("非公開プロジェクトのアイコン (ADR-0028)", () => {
    const GYAZO = "fedcba9876543210fedcba9876543210";
    const pageWith = (image: string | null, texts: readonly string[] = PROFILE) =>
      JSON.stringify({ ...pageOf(texts, { image }), lines: linesOf(texts) });

    it("**ページの画像が Gyazo なら、貼る行に `i=` を付ける。** 追加の取得はしない (今読んだページの `image` を使う)", async () => {
      const t = await harness({ pages: [pageWith(`https://gyazo.com/${GYAZO}/raw`)] });

      expect(await t.card.ensure("p")).toBe("inserted");

      const names = { project: "p", user: "alice", icon: GYAZO };
      expect(t.commits[0]?.changes[0]).toMatchObject({
        lines: { text: cardLine(t.publicId, names) },
      });
      expect(cardLine(t.publicId, names)).toContain(`&i=${GYAZO}]`);
      expect(t.fetched).toEqual(["/api/pages/p/alice", "/api/users/me", "/api/projects/p"]);
    });

    it("**カードの図がページの画像になるときも、行と画像が同じ URL** (`i=` 付き)", async () => {
      // 今の画像の行が足す位置より後ろにあるので、カードが最初の画像になる
      const texts = [...PROFILE, `[https://gyazo.com/${GYAZO}/raw]`];
      const t = await harness({ pages: [pageWith(`https://gyazo.com/${GYAZO}/raw`, texts)] });

      expect(await t.card.ensure("p")).toBe("inserted");

      const names = { project: "p", user: "alice", icon: GYAZO };
      const src = cardUrl(t.publicId, names);
      expect(src).toContain(`&i=${GYAZO}`);
      expect(t.commits[0]?.changes).toContainEqual({ image: src });
      expect(t.commits[0]?.changes[0]).toMatchObject({ lines: { text: `[${src}]` } });
    });

    it("**画像が Gyazo でなければ (Cosense のファイル・外部 URL・画像なし) `i=` は付けない**", async () => {
      for (const image of [
        "https://scrapbox.io/files/0123456789abcdef01234567.png",
        "https://example.com/a.png",
        null,
      ]) {
        const t = await harness({ pages: [pageWith(image)] });

        expect(await t.card.ensure("p"), String(image)).toBe("inserted");

        const text = t.commits[0]?.changes[0].lines.text ?? "";
        expect(text, String(image)).toBe(cardLine(t.publicId, { project: "p", user: "alice" }));
        expect(text, String(image)).not.toContain("&i=");
      }
    });

    it("**読み直したページの画像で作り直す** (NotFastForward の後に画像が替わっていたら、その `i=` で送る)", async () => {
      const t = await harness({
        pages: [pageWith(null), pageWith(`https://gyazo.com/${GYAZO}/raw`)],
      });
      t.state.results = [
        { kind: "rejected", name: "NotFastForwardError" },
        { kind: "committed", commitId: "commit-3" },
      ];

      expect(await t.card.ensure("p")).toBe("inserted");

      expect(t.commits).toHaveLength(2);
      const texts = t.commits.map((commit) => commit.changes[0].lines.text);
      expect(texts[0]).toBe(cardLine(t.publicId, { project: "p", user: "alice" }));
      expect(texts[0]).not.toContain("&i=");
      expect(texts[1]).toBe(cardLine(t.publicId, { project: "p", user: "alice", icon: GYAZO }));
      expect(texts[1]).toContain(`&i=${GYAZO}]`);
    });
  });

  it("**行があれば何もしない** (普段は GET 1 回で終わる)", async () => {
    const t = await harness();
    t.state.pages = [t.pageBody([...PROFILE, cardLine(t.publicId, { project: "p" })])];

    expect(await t.card.ensure("p")).toBe("present");

    expect(t.fetched).toEqual(["/api/pages/p/alice"]);
    expect(t.commits).toEqual([]);
  });

  it("**登録していない・ログインしていないなら何も読まない**", async () => {
    const unenrolled = await harness();
    unenrolled.state.device = { kind: "missing" };
    expect(await unenrolled.card.ensure("p")).toBe("not-enrolled");
    expect(unenrolled.fetched).toEqual([]);

    const broken = await harness();
    broken.card = createProfileCard({
      keys: { read: () => Promise.reject(new Error("IndexedDB")) },
      userName: () => "alice",
      fetchText: async (path) => {
        broken.fetched.push(path);
        return undefined;
      },
      sendCommit: async () => ({ kind: "failed", reason: "closed" }),
      withLock: (_name, run) => run(),
      now: () => new Date(),
      random: () => 0,
      log: () => undefined,
      warn: () => undefined,
    });
    expect(await broken.card.ensure("p")).toBe("not-enrolled");

    const guest = await harness();
    guest.state.user = undefined;
    expect(await guest.card.ensure("p")).toBe("not-logged-in");
    expect(guest.fetched).toEqual([]);
  });

  it("**未登録で飛ばした後、登録してから呼べば確かめる**", async () => {
    const t = await harness();
    t.state.device = { kind: "missing" };
    expect(await t.card.ensure("p")).toBe("not-enrolled");

    t.state.device = { kind: "found", record: { uid: UID } } as unknown as DeviceRead;
    expect(await t.card.ensure("p")).toBe("inserted");
  });

  it("**ページが無い (404)・まだ保存されていないなら何もしない** (ページを作らない)", async () => {
    const missing = await harness({ pages: [undefined] });
    expect(await missing.card.ensure("p")).toBe("no-page");

    const unsaved = await harness({
      pages: [JSON.stringify({ ...pageOf(["alice"]), persistent: false })],
    });
    expect(await unsaved.card.ensure("p")).toBe("no-page");

    expect([...missing.commits, ...unsaved.commits]).toEqual([]);
  });

  it("**タイトルだけのページには貼らない** (最上部になる)", async () => {
    const t = await harness();
    t.state.pages = [t.pageBody(["alice"])];

    expect(await t.card.ensure("p")).toBe("no-position");
    expect(t.commits).toEqual([]);
  });

  it("**NotFastForward なら読み直し、行がもうあれば送らない**", async () => {
    const t = await harness();
    t.state.pages = [
      t.pageBody(PROFILE),
      // ほかのタブが先に貼った
      t.pageBody([
        ...PROFILE.slice(0, 4),
        cardLine(t.publicId, { project: "p" }),
        ...PROFILE.slice(4),
      ]),
    ];
    t.state.results = [{ kind: "rejected", name: "NotFastForwardError" }];

    expect(await t.card.ensure("p")).toBe("present");

    expect(t.commits).toHaveLength(1);
    expect(t.fetched.filter((path) => path === "/api/pages/p/alice")).toHaveLength(2);
  });

  it("**NotFastForward なら読み直した版を親にして送り直す**", async () => {
    const t = await harness();
    t.state.pages = [
      t.pageBody(PROFILE),
      JSON.stringify({
        ...pageOf([...PROFILE, "追記"]),
        commitId: "commit-9",
        lines: linesOf([...PROFILE, "追記"]),
      }),
    ];
    t.state.results = [
      { kind: "rejected", name: "NotFastForwardError" },
      { kind: "committed", commitId: "commit-10" },
    ];

    expect(await t.card.ensure("p")).toBe("inserted");

    expect(t.commits.map((commit) => commit.parentId)).toEqual(["commit-1", "commit-9"]);
    // 自分の id とプロジェクトの id は 1 回だけ引く
    expect(t.fetched.filter((path) => path === "/api/users/me")).toHaveLength(1);
  });

  it(`**NotFastForward が続けば ${MAX_ATTEMPTS} 回で止める**`, async () => {
    const t = await harness();
    t.state.results = [{ kind: "rejected", name: "NotFastForwardError" }];

    expect(await t.card.ensure("p")).toBe("conflict");

    expect(MAX_ATTEMPTS).toBe(3);
    expect(t.commits).toHaveLength(MAX_ATTEMPTS);
    expect(t.warnings).toHaveLength(1);
  });

  it("**ほかのエラー・タイムアウトでは送り直さず、短く知らせる**", async () => {
    for (const result of [
      { kind: "rejected", name: "DuplicateTitleError" },
      { kind: "failed", reason: "timeout" },
    ] as const) {
      const t = await harness();
      t.state.results = [result];

      expect(await t.card.ensure("p")).toBe("failed");

      expect(t.commits).toHaveLength(1);
      expect(t.warnings).toEqual([
        `プロフィールページにカードの図を貼れませんでした (${"name" in result ? result.name : result.reason})`,
      ]);
    }
  });

  it("**通信に失敗しても例外を投げず、短く知らせる**", async () => {
    const t = await harness();
    t.state.fetchError = true;

    expect(await t.card.ensure("p")).toBe("failed");
    expect(t.warnings).toEqual(["プロフィールページを確かめられませんでした"]);
  });

  it("**自分の id かプロジェクトの id を読めなければ送らない**", async () => {
    for (const unreadable of ["/api/users/me", "/api/projects/p"]) {
      const commits: PageCommit[] = [];
      const card = createProfileCard({
        keys: {
          read: async () => ({ kind: "found", record: { uid: UID } }) as unknown as DeviceRead,
        },
        userName: () => "alice",
        fetchText: async (path) =>
          path === "/api/pages/p/alice"
            ? JSON.stringify({ ...pageOf(PROFILE), lines: linesOf(PROFILE) })
            : path === unreadable
              ? '{"isGuest":true}'
              : '{"id":"5f0000000000000000000001"}',
        sendCommit: async (commit) => {
          commits.push(commit);
          return { kind: "committed", commitId: "c" };
        },
        withLock: (_name, run) => run(),
        now: () => new Date(),
        random: () => 0,
        log: () => undefined,
        warn: () => undefined,
      });

      expect(await card.ensure("p")).toBe("failed");
      expect(commits).toEqual([]);
    }
  });

  it("**同じページ読み込みでは、1 つのプロジェクトにつき 1 回だけ確かめる**", async () => {
    const t = await harness();
    t.state.results = [{ kind: "failed", reason: "closed" }];

    expect(await t.card.ensure("p")).toBe("failed");
    expect(await t.card.ensure("p")).toBe("already-checked");
    expect(t.commits).toHaveLength(1);
    // 別のプロジェクトは別に確かめる (ページが無いので何もしない)
    expect(await t.card.ensure("other")).toBe("no-page");
  });

  it("**ログに URL・publicId・ページの中身を出さない**", async () => {
    for (const result of [
      { kind: "committed", commitId: "c" },
      { kind: "rejected", name: "NotFastForwardError" },
      { kind: "rejected", name: `https://grass.soui.dev/v1/g/x/card.svg ${"a".repeat(100)}` },
      { kind: "failed", reason: "protocol" },
    ] as const) {
      const t = await harness();
      t.state.results = [result];
      await t.card.ensure("p");

      for (const message of [...t.logs, ...t.warnings]) {
        expect(message).not.toContain(t.publicId);
        expect(message).not.toMatch(/https?:|grass\.soui|alice|自己紹介/);
      }
    }
  });
});
