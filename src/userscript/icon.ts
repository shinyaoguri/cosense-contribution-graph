/**
 * 非公開プロジェクトのアイコンの手がかり (ADR-0028、Issue #234)。
 *
 * **Worker は Cosense の認証を持たないので、非公開プロジェクトのアイコンを引けない** (未認証の `/icon` は 401。research §4)。
 * ログインしたブラウザで動く UserScript だけが、そのページの `image` を読める。そこから **Gyazo の画像 ID だけ**を取り出し、
 * 図の URL の `i=` に添える。Worker は ID から `https://gyazo.com/<id>/max_size/64` を自分で組み立てて取る (任意の URL は取らない)。
 *
 * - 取れるのは Gyazo のアイコンだけ。Cosense のファイル (`scrapbox.io/files/…`) や外部 URL は渡さず、Worker は従来どおり `/icon` を引く
 *   (2026-10-08 の実測では、非公開プロジェクトの `image` は 6 件とも Gyazo だった)
 * - **`/api/pages/<project>/<user>` を引く。** 同一オリジンで認証付き (`connect-src 'self'`。research §1)。
 *   プロフィールページに貼る行は、すでに読んだページの `image` を使うので引かない (`profile.ts`)
 */
import { isValidGyazoId } from "../shared/gyazo-id.ts";

/** ページの `image` に現れる Gyazo の URL の形 (`/raw`・元の URL・`i.gyazo.com/<id>.png`)。**https で、ホストは Gyazo だけ** */
const GYAZO_IMAGE = /^https:\/\/(?:i\.)?gyazo\.com\/([0-9a-f]{32})(?=[/.?#]|$)/;

/**
 * ページの `image` から Gyazo の画像 ID を取り出す。**Gyazo の URL でなければ `undefined`。**
 * Cosense のファイル・外部 URL・画像なしはどれも渡さない (Worker が従来の `/icon` を引く)
 */
export function gyazoIdOf(image: string | null | undefined): string | undefined {
  const id = image === null || image === undefined ? undefined : GYAZO_IMAGE.exec(image)?.[1];
  return id !== undefined && isValidGyazoId(id) ? id : undefined;
}

export type IconResolverDependencies = {
  /** 同一オリジンの GET。**通信の失敗は投げてよい** (ここで握りつぶす)。本番は `AbortSignal.timeout` で待つ上限を持つ */
  readonly fetchText: (path: string) => Promise<string | undefined>;
};

export type IconResolver = (
  project: string,
  user: string | undefined,
) => Promise<string | undefined>;

/**
 * プロジェクトのユーザー名のページ (`<project>/<user>`) の `image` から、Gyazo の画像 ID を返す。
 *
 * - **プロジェクトごとにこのページの読み込みの間だけ覚える。** 同時に頼まれても 1 回しか引かない
 * - **失敗は `undefined` にして例外を外へ出さない。** ユーザー名が無い (未ログイン)・ページが無い・まだ保存されていない・
 *   画像が無い・Gyazo でない・応答が壊れている・通信の失敗、のどれも「手がかり無し」
 */
export function createIconResolver(deps: IconResolverDependencies): IconResolver {
  const memo = new Map<string, Promise<string | undefined>>();

  const lookUp = async (project: string, user: string): Promise<string | undefined> => {
    try {
      const body = await deps.fetchText(
        `/api/pages/${encodeURIComponent(project)}/${encodeURIComponent(user)}`,
      );
      const json: unknown = body === undefined ? undefined : JSON.parse(body);
      if (typeof json !== "object" || json === null || Array.isArray(json)) {
        return undefined;
      }
      const page = json as { persistent?: unknown; image?: unknown };
      // まだ保存されていないページは REST が 200 を返す。そこに画像は無い
      if (page.persistent === false || typeof page.image !== "string") {
        return undefined;
      }
      return gyazoIdOf(page.image);
    } catch {
      return undefined;
    }
  };

  return (project, user) => {
    if (user === undefined || user === "") {
      return Promise.resolve(undefined);
    }
    // 鍵はプロジェクトだけ。**ユーザーは 1 つの読み込みの間で変わらない** (ログインは 1 人)
    let pending = memo.get(project);
    if (pending === undefined) {
      pending = lookUp(project, user);
      memo.set(project, pending);
    }
    return pending;
  };
}
