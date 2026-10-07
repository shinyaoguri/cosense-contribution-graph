/**
 * プロフィールページ (各プロジェクトの自分のユーザー名のページ) にカードの図の行を貼り続ける (ADR-0025、design §9)。
 * **UserScript がページに書く初めての機能。**
 *
 * - 開くたびに REST でプロフィールページを読み、**そのプロジェクトの publicId を含む `/v1/g/<publicId>/card.svg` の行**があるかを見る。
 *   あれば何もしない (普段は GET 1 回で終わる)。オリジン・`l` / `u`・行の前後の文字は問わない (決定 4)
 * - 無ければ cosense-grass を読み込むコードブロックの直後に 1 行足す (決定 2)。送るのは `cosense-socket.ts`
 * - **不変条件: `_insert` だけを送り (既存の行を update も delete もしない)、コードブロックの外に入れる** (決定 3)。
 *   中に入ると配信される script.js が変わり、SHA1 の承認ゲートで UserScript そのものが止まる (research §2)
 * - 親が古ければ (`NotFastForwardError`) 読み直して確かめ直す (最大 3 回)。タブどうしは Web Locks で直列にする (決定 5)
 * - **1 回のページ読み込みで、1 つのプロジェクトにつき 1 回だけ** 確かめる
 * - **URL・publicId・ページの中身はログに出さない** (`graph-dialog.ts` と同じ方針)
 *
 * commit とメタデータの形は `@cosense/std` (GitHub takker99/scrapbox-userscript-std) を 2026-10-07 に読んで合わせた。
 * - `websocket/push.ts` — commit は `{kind: "page", projectId, pageId, parentId, userId, changes, cursor: null, freeze: true}`
 * - `websocket/diffToChanges.ts` — 挿入は `{_insert: <この行の前に入れる行の id か "_end">, lines: {id, text}}`
 * - `websocket/id.ts` — 新しい行の id (`createNewLineId`)
 * - `websocket/makeChanges.ts` と `getPageMetadataFromLines.ts` — メタデータの差分。本文の差分の後に、変わったものだけを
 *   `title` / `links` / `projectLinks` / `icons` / `image` / `descriptions` / `files` / `helpfeels` / `infoboxDefinition` の順で足し、
 *   最後に `linesCount` と `charsCount` を必ず足す
 * - 行の区切り (コードブロック・テーブル) は `@progfay/scrapbox-parser` の `block/Pack.ts` (`std` が使うパーサ)
 *
 * カードの行が変えうるメタデータは `image` / `descriptions` / `linesCount` / `charsCount` だけ。リンク付きの画像の行は
 * リンク (`links` / `projectLinks`)・アイコン・ファイル (`scrapbox.io/files/…` ではない)・helpfeel・infobox を足さない。
 */
import type { CommitResult } from "./cosense-socket.ts";
import type { DeviceStore } from "./keys.ts";
import { DISTRIBUTION_PATH, ME_PATH } from "./sensor.ts";
import { cardLine, cardUrl, graphIds } from "./worker-origin.ts";

/** 読み直して確かめ直す回数の上限 (ADR-0025 決定 5) */
export const MAX_ATTEMPTS = 3;

/** ページの末尾に足すときの `_insert` の値 */
export const END = "_end";

/** ページの 1 行。REST `/api/pages/:project/:title` の `lines[]` のうち使うもの */
export type PageLine = { readonly id: string; readonly text: string };

/** REST `/api/pages/:project/:title` のうち使うもの (research §4) */
export type ProfilePage = {
  readonly id: string;
  /** 最新の commit。commit の `parentId` にする */
  readonly commitId: string;
  /** まだ保存されていないページは false (REST はそれでも 200 を返す) */
  readonly persistent: boolean;
  readonly image: string | null;
  readonly descriptions: readonly string[];
  /** 先頭はタイトル行 */
  readonly lines: readonly PageLine[];
};

/** 送る変更。**`_update` と `_delete` は型にも持たない** (決定 3) */
type InsertChange = {
  readonly _insert: string;
  readonly lines: { readonly id: string; readonly text: string };
};
type MetadataChange =
  | { readonly image: string | null }
  | { readonly descriptions: readonly string[] }
  | { readonly linesCount: number }
  | { readonly charsCount: number };

export type PageCommit = {
  readonly kind: "page";
  readonly parentId: string;
  readonly changes: readonly [InsertChange, ...MetadataChange[]];
  readonly cursor: null;
  readonly pageId: string;
  readonly userId: string;
  readonly projectId: string;
  readonly freeze: true;
};

/** 足す位置。`before` の行の前に入る (`_end` なら末尾)。`index` は足した後のその行の位置 */
export type InsertPoint = { readonly before: string; readonly index: number };

/** カードの図の URL のうち、publicId で決まる部分。**オリジンとクエリは問わない** (決定 4) */
function cardPathOf(publicId: string): string {
  return `/v1/g/${publicId}/card.svg`;
}

/** そのプロジェクトのカードの図の行がもうあるか。ほかのプロジェクトや合算のカードは数えない (publicId が違う) */
export function hasCardLine(lines: readonly PageLine[], publicId: string): boolean {
  const path = cardPathOf(publicId);
  return lines.some((line) => line.text.includes(path));
}

/** 行の字下げ。パーサと同じく先頭の空白類の長さ (`block/Row.ts`) */
function indentOf(text: string): number {
  return /^\s+/.exec(text)?.[0].length ?? 0;
}

/** タイトルを除いた行のまとまり。`end` は含まない */
type Pack = {
  readonly kind: "code" | "table" | "line";
  readonly start: number;
  end: number;
  readonly indent: number;
};

/**
 * 行をまとまりに分ける (`@progfay/scrapbox-parser` の `block/Pack.ts` と同じ規則)。
 * `code:` / `table:` で始まる行から、**それより深く字下げされた行が続く間**が 1 つのブロック。空行で終わる
 */
function packsOf(lines: readonly PageLine[]): Pack[] {
  const packs: Pack[] = [];
  for (let i = 1; i < lines.length; i++) {
    const text = lines[i]?.text ?? "";
    const indent = indentOf(text);
    const last = packs.at(-1);
    if (last !== undefined && last.kind !== "line" && indent > last.indent) {
      last.end = i + 1;
      continue;
    }
    const kind = /^\s*code:/.test(text) ? "code" : /^\s*table:/.test(text) ? "table" : "line";
    packs.push({ kind, start: i, end: i + 1, indent });
  }
  return packs;
}

/**
 * カードの行を足す位置 (決定 2)。cosense-grass を読み込むコードブロック (中の行が `/api/code/cosense-grass/` を含む)
 * の最後の行の直後。そのブロックが無ければ末尾。
 *
 * **タイトルの直後 (最上部) には置かない。** ページがタイトルの 1 行だけなら末尾がタイトルの直後になるので、足さない (`undefined`)。
 * 導入済みならプロフィールページには import のコードブロックがあるはずで、ここに来るのは読み直しの間に消されたときくらい
 */
export function insertionPoint(lines: readonly PageLine[]): InsertPoint | undefined {
  const block = packsOf(lines).find(
    (pack) =>
      pack.kind === "code" &&
      lines.slice(pack.start + 1, pack.end).some((line) => line.text.includes(DISTRIBUTION_PATH)),
  );
  if (block !== undefined) {
    return { before: lines[block.end]?.id ?? END, index: block.end };
  }
  if (lines.length < 2) {
    return undefined;
  }
  return { before: END, index: lines.length };
}

/**
 * 新しい行の id。`@cosense/std` の `websocket/id.ts` の `createNewLineId` と同じ形
 * (秒の 16 進 8 桁 + userId の末尾 6 桁 + `0000` + 乱数の 16 進を 8 桁に詰めたもの)
 */
export function newLineId(userId: string, now: Date, random: () => number): string {
  const zero = (n: string) => n.padStart(8, "0");
  const time = Math.floor(now.getTime() / 1000).toString(16);
  const rand = Math.floor(0xfffffe * random()).toString(16);
  return `${zero(time).slice(-8)}${userId.slice(-6)}0000${zero(rand)}`;
}

/**
 * ページの `image` が指す画像を本文の中で探すための手がかり。
 * `image` は本文の URL から形を変えて作られる (Gyazo は `/raw` が付く、YouTube はサムネの URL になる。research §3)
 */
function imageKeyOf(image: string): string {
  return (
    /gyazo\.com\/([0-9a-f]{32})/.exec(image)?.[1] ??
    /i\.ytimg\.com\/vi\/([^/]+)\//.exec(image)?.[1] ??
    /\/files\/([0-9a-f]{24})/.exec(image)?.[1] ??
    image
  );
}

/**
 * 足した後の `image`。**変わらなければ `undefined`** (差分に入れない)。
 *
 * ページの `image` は本文の最初の画像 (タイトル・コードブロック・テーブルの中は除く。research §3)。
 * - 画像が無いページでは、カードの図が最初の画像になる
 * - 今の画像の行が足す位置より後ろにあれば、カードの図が最初の画像になる
 * - **今の画像の行が見つからなければ変えない。** 誤ってサムネを差し替えるより、変えずに残す方を選ぶ
 *   (本体が次にページを保存するときに計算し直す)
 */
function imageAfter(page: ProfilePage, at: number, src: string): string | undefined {
  if (page.image === null) {
    return src;
  }
  const key = imageKeyOf(page.image);
  const found = packsOf(page.lines).find(
    (pack) => pack.kind === "line" && page.lines[pack.start]?.text.includes(key),
  );
  if (found === undefined || found.start < at) {
    return undefined;
  }
  return src;
}

/** 説明 (`descriptions`) は本文の先頭 5 つ。`getPageMetadataFromLines.ts` と同じ */
const MAX_DESCRIPTIONS = 5;
const MAX_DESCRIPTION_LENGTH = 200;

/**
 * 足した後の `descriptions`。**変わらなければ `undefined`**。
 *
 * 説明は、タイトルの後の中身のある行とコードブロックを上から 5 つ (テーブルと空行は数えない)。
 * 足す位置より前に 5 つ以上あれば変わらない。前にある数が今の説明の数より多いときは、数え方が本体と食い違っているので変えない
 */
function descriptionsAfter(
  page: ProfilePage,
  at: number,
  text: string,
): readonly string[] | undefined {
  const before = packsOf(page.lines).filter(
    (pack) =>
      pack.end <= at &&
      (pack.kind === "code" ||
        (pack.kind === "line" && (page.lines[pack.start]?.text ?? "").trim() !== "")),
  ).length;
  if (before >= MAX_DESCRIPTIONS || before > page.descriptions.length) {
    return undefined;
  }
  return [
    ...page.descriptions.slice(0, before),
    text.trim().slice(0, MAX_DESCRIPTION_LENGTH),
    ...page.descriptions.slice(before),
  ].slice(0, MAX_DESCRIPTIONS);
}

/**
 * カードの行を 1 つ足す commit を組み立てる。**変更は `_insert` 1 つとメタデータの差分だけ** (決定 3)。
 * `text` は貼る行、`src` はその行の画像の URL (ページの `image` になりうる)
 */
export function buildCommit(input: {
  readonly page: ProfilePage;
  readonly point: InsertPoint;
  readonly text: string;
  readonly src: string;
  readonly lineId: string;
  readonly userId: string;
  readonly projectId: string;
}): PageCommit {
  const { page, point, text } = input;
  const after = [
    ...page.lines.slice(0, point.index).map((line) => line.text),
    text,
    ...page.lines.slice(point.index).map((line) => line.text),
  ];
  const metadata: MetadataChange[] = [];
  const image = imageAfter(page, point.index, input.src);
  if (image !== undefined && image !== page.image) {
    metadata.push({ image });
  }
  const descriptions = descriptionsAfter(page, point.index, text);
  if (descriptions !== undefined) {
    metadata.push({ descriptions });
  }
  metadata.push(
    { linesCount: after.length },
    // 文字数はコードポイントで数える (`[...line].length`)
    { charsCount: after.reduce((sum, line) => sum + [...line].length, 0) },
  );
  return {
    kind: "page",
    parentId: page.commitId,
    changes: [{ _insert: point.before, lines: { id: input.lineId, text } }, ...metadata],
    cursor: null,
    pageId: page.id,
    userId: input.userId,
    projectId: input.projectId,
    freeze: true,
  };
}

/** REST の応答からページを読む。形が違えば `undefined` */
export function parsePage(text: string): ProfilePage | undefined {
  const json = parseJson(text);
  if (!isObject(json) || typeof json.id !== "string" || typeof json.commitId !== "string") {
    return undefined;
  }
  if (!Array.isArray(json.lines)) {
    return undefined;
  }
  const lines: PageLine[] = [];
  for (const line of json.lines) {
    if (!isObject(line) || typeof line.id !== "string" || typeof line.text !== "string") {
      return undefined;
    }
    lines.push({ id: line.id, text: line.text });
  }
  const descriptions = Array.isArray(json.descriptions)
    ? json.descriptions.filter((d): d is string => typeof d === "string")
    : [];
  return {
    id: json.id,
    commitId: json.commitId,
    persistent: json.persistent !== false,
    image: typeof json.image === "string" ? json.image : null,
    descriptions,
    lines,
  };
}

/** REST の応答から `id` を読む (`/api/users/me` と `/api/projects/:project`)。未ログインなどで無ければ `undefined` */
function idOf(text: string | undefined): string | undefined {
  const json = text === undefined ? undefined : parseJson(text);
  return isObject(json) && typeof json.id === "string" && json.id !== "" ? json.id : undefined;
}

export type ProfileCardDependencies = {
  readonly keys: Pick<DeviceStore, "read">;
  /** Cosense のユーザー名 (`scrapbox.User.name`)。**未ログインなら `undefined`** */
  readonly userName: () => string | undefined;
  /**
   * 同一オリジンのパスを読む (`sensor.ts` と同じ約束)。**成功でなければ `undefined`** (404 = ページが無い)、
   * 通信の失敗は例外。読み直しで古い版を掴まないよう、本番はキャッシュを使わない
   */
  readonly fetchText: (path: string) => Promise<string | undefined>;
  readonly sendCommit: (commit: PageCommit) => Promise<CommitResult>;
  /** 本番は Web Locks、無ければそのまま走らせる */
  readonly withLock: <T>(name: string, run: () => Promise<T>) => Promise<T>;
  readonly now: () => Date;
  readonly random: () => number;
  /** 貼ったことを知らせる。URL や publicId は渡さない */
  readonly log: (message: string) => void;
  /** 貼れなかった理由の種類だけを渡す */
  readonly warn: (message: string) => void;
};

type ProfileOutcome =
  | "not-enrolled"
  | "not-logged-in"
  /** このページ読み込みで、このプロジェクトはもう確かめた */
  | "already-checked"
  /** プロフィールページが無い・まだ保存されていない */
  | "no-page"
  | "present"
  /** 最上部にしか置けない (タイトルだけのページ) */
  | "no-position"
  | "inserted"
  /** 読み直しても親が古いまま (上限に達した) */
  | "conflict"
  | "failed";

export type ProfileCard = {
  /** **そのプロジェクトに導入済みのときだけ呼ぶ** (呼ぶ側が判定する。index.ts) */
  ensure(project: string): Promise<ProfileOutcome>;
};

export function createProfileCard(deps: ProfileCardDependencies): ProfileCard {
  const checked = new Set<string>();

  return {
    async ensure(project) {
      let uid: string;
      try {
        const device = await deps.keys.read();
        if (device.kind !== "found") {
          return "not-enrolled";
        }
        uid = device.record.uid;
      } catch {
        return "not-enrolled";
      }
      const user = deps.userName();
      if (user === undefined || user === "") {
        return "not-logged-in";
      }
      if (checked.has(project)) {
        return "already-checked";
      }
      // **失敗しても印を付ける。** 同じ読み込みで何度も試さない (次にページを開いたときに試し直す)
      checked.add(project);
      try {
        const outcome = await deps.withLock(`cosense-grass:profile:${project}`, () =>
          insertIfMissing(project, user, uid, deps),
        );
        if (outcome === "inserted") {
          deps.log("プロフィールページにカードの図を貼りました");
        } else if (outcome === "conflict") {
          deps.warn("プロフィールページが続けて更新されていたので、カードの図を貼りませんでした");
        }
        return outcome;
      } catch {
        deps.warn("プロフィールページを確かめられませんでした");
        return "failed";
      }
    },
  };
}

async function insertIfMissing(
  project: string,
  user: string,
  uid: string,
  deps: ProfileCardDependencies,
): Promise<ProfileOutcome> {
  const { publicId } = await graphIds(uid, project);
  const names = { project, user };
  const text = cardLine(publicId, names);
  const src = cardUrl(publicId, names);
  const pagePath = `/api/pages/${encodeURIComponent(project)}/${encodeURIComponent(user)}`;
  let ids: { userId: string; projectId: string } | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const body = await deps.fetchText(pagePath);
    const page = body === undefined ? undefined : parsePage(body);
    // **ページを作らない。** 無いページに足すと新しいページができてしまう
    if (page === undefined || !page.persistent) {
      return "no-page";
    }
    if (hasCardLine(page.lines, publicId)) {
      return "present";
    }
    const point = insertionPoint(page.lines);
    if (point === undefined) {
      return "no-position";
    }
    ids ??= await idsOf(project, deps);
    if (ids === undefined) {
      deps.warn("Cosense のユーザーかプロジェクトを読めなかったので、カードの図を貼りませんでした");
      return "failed";
    }
    const result = await deps.sendCommit(
      buildCommit({
        page,
        point,
        text,
        src,
        lineId: newLineId(ids.userId, deps.now(), deps.random),
        ...ids,
      }),
    );
    if (result.kind === "committed") {
      return "inserted";
    }
    // 親が古い: ほかの編集が先に入った。読み直して、行があるかから確かめ直す
    if (result.kind === "rejected" && result.name.includes("NotFastForward")) {
      continue;
    }
    deps.warn(
      `プロフィールページにカードの図を貼れませんでした (${result.kind === "rejected" ? nameOf(result.name) : result.reason})`,
    );
    return "failed";
  }
  return "conflict";
}

/** 自分の id とプロジェクトの id (commit に要る。research §4)。どちらかが読めなければ `undefined` */
async function idsOf(
  project: string,
  deps: Pick<ProfileCardDependencies, "fetchText">,
): Promise<{ userId: string; projectId: string } | undefined> {
  const [me, info] = await Promise.all([
    deps.fetchText(ME_PATH),
    deps.fetchText(`/api/projects/${encodeURIComponent(project)}`),
  ]);
  const userId = idOf(me);
  const projectId = idOf(info);
  return userId !== undefined && projectId !== undefined ? { userId, projectId } : undefined;
}

/** サーバのエラーの名前をログに出す形に絞る (想定外の長い文字列を出さない) */
function nameOf(name: string): string {
  return /^\w{1,64}$/.test(name) ? name : "error";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
