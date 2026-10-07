/**
 * Cosense 本体と同じ WebSocket の経路で commit を 1 つ送る (ADR-0025 決定 1、research §1・§4)。
 *
 * **ライブラリを使わず、ネイティブの `WebSocket` の上に Engine.IO v4 / socket.io v5 の最小限を書く。**
 * socket.io-client を足すとバンドルが倍になる (research §4)。やり取りは 1 往復だけなので、要るのは次のとおり。
 *
 * ```
 * サーバ → 0{"sid":…,"pingInterval":25000,"pingTimeout":20000,…}   Engine.IO の open
 * 送る   → 40                                                     socket.io の CONNECT (既定の名前空間)
 * サーバ → 40{"sid":…}                                            CONNECT の応答
 * 送る   → 42<ack>["socket.io-request",{"method":"commit","data":<commit>}]   ack つきの EVENT
 * サーバ → 43<ack>[{"data":{"commitId":…}}] か 43<ack>[{"error":{"name":…}}] ACK
 * サーバ → 2 / 送る → 3                                           ping / pong (いつ来ても返す)
 * ```
 *
 * 出典 (2026-10-07 に読んだ):
 * - `@cosense/std` (GitHub takker99/scrapbox-userscript-std) の `websocket/socket.ts` — 接続は
 *   `io("https://scrapbox.io", { reconnectionDelay: 5000, transports: ["websocket"] })`。ブラウザでは Cookie だけで認証する
 * - 同 `websocket/emit.ts` — commit は socket.io-request の形 (`socket.emit("socket.io-request", {method: "commit", data}, ack)`) で送り、
 *   ack の引数が `{data}` なら成功、`{error}` なら失敗 (`NotFastForwardError` / `DuplicateTitleError` / `SocketIOError`)。既定のタイムアウトは 90 秒
 * - 同 `websocket/push.ts` — commit の前に `room:join` を送っていない
 * - パケットの番号は Engine.IO v4 (open 0・close 1・ping 2・pong 3・message 4) と socket.io v5 (CONNECT 0・DISCONNECT 1・EVENT 2・ACK 3・CONNECT_ERROR 4) の仕様
 *
 * **全体にタイムアウトを付け、結果が出たら必ず閉じる。** 再接続はしない (失敗したら次にページを開いたときに試し直す)。
 * ping の間隔 (25 秒) より全体のタイムアウト (20 秒) が短いので、ping の途絶えは見張らない。
 */

/** 本体と同じ接続先。polling は 400 を返すので websocket だけ (research §1 の 2026-10-07) */
export const SOCKET_URL = "wss://scrapbox.io/socket.io/?EIO=4&transport=websocket";

/** 開いてから応答までの上限。本体は 90 秒待つが、裏で 1 行貼るだけなので短くする */
export const COMMIT_TIMEOUT_MS = 20_000;

/** 1 接続で 1 回しか送らないので固定でよい */
const ACK_ID = 0;

/** 使う `WebSocket` の部分。テストでは偽物を渡す */
export type SocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
};

export type CosenseSocketDependencies = {
  /** 本番は `new WebSocket(url)` */
  readonly openSocket: (url: string) => SocketLike;
  readonly setTimeout: (handler: () => void, ms: number) => number;
  readonly clearTimeout: (id: number) => void;
  readonly timeoutMs?: number;
};

/**
 * 送った結果。**`rejected` の `name` はサーバの返したエラーの名前** (`NotFastForwardError` など)。
 * `failed` はサーバの判断まで届かなかったもの
 */
export type CommitResult =
  | { readonly kind: "committed"; readonly commitId: string }
  | { readonly kind: "rejected"; readonly name: string }
  | {
      readonly kind: "failed";
      readonly reason: "timeout" | "connect" | "closed" | "protocol";
    };

/** commit を 1 つ送り、応答を待って閉じる。**例外は投げない** (結果で返す) */
export function sendCommit(
  commit: unknown,
  deps: CosenseSocketDependencies,
): Promise<CommitResult> {
  return new Promise((resolve) => {
    let socket: SocketLike | undefined;
    /** `open` → `0` を待つ、`connecting` → `40` を待つ、`waiting` → ACK を待つ */
    let state: "open" | "connecting" | "waiting" = "open";
    let done = false;

    const finish = (result: CommitResult) => {
      if (done) {
        return;
      }
      done = true;
      deps.clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // 閉じられなくても結果は変わらない
      }
      resolve(result);
    };
    const timer = deps.setTimeout(
      () => finish({ kind: "failed", reason: "timeout" }),
      deps.timeoutMs ?? COMMIT_TIMEOUT_MS,
    );

    const onPacket = (packet: string) => {
      switch (packet[0]) {
        case "0": {
          // Engine.IO の open。中身が JSON のオブジェクトでなければ相手が違う
          if (state !== "open" || !isObject(parseJson(packet.slice(1)))) {
            finish({ kind: "failed", reason: "protocol" });
            return;
          }
          state = "connecting";
          socket?.send("40");
          return;
        }
        case "1":
          finish({ kind: "failed", reason: "closed" });
          return;
        case "2":
          // ping。返さないとサーバが pingTimeout で切る
          socket?.send("3");
          return;
        case "4":
          onMessage(packet.slice(1));
          return;
        default:
          // pong・noop など。使わない
          return;
      }
    };

    const onMessage = (message: string) => {
      switch (message[0]) {
        case "0": {
          if (state !== "connecting") {
            return;
          }
          state = "waiting";
          socket?.send(
            `42${ACK_ID}${JSON.stringify(["socket.io-request", { method: "commit", data: commit }])}`,
          );
          return;
        }
        case "1":
          finish({ kind: "failed", reason: "closed" });
          return;
        case "3":
          onAck(message.slice(1));
          return;
        case "4":
          // CONNECT_ERROR (未ログインなどで名前空間に入れない)
          finish({ kind: "failed", reason: "connect" });
          return;
        default:
          // ほかのイベント (ページの更新の通知など) は使わない
          return;
      }
    };

    const onAck = (body: string) => {
      const matched = /^(\d+)(\[[\s\S]*\])$/.exec(body);
      if (matched === null || Number(matched[1]) !== ACK_ID || state !== "waiting") {
        return;
      }
      const args = parseJson(matched[2] ?? "");
      const response = Array.isArray(args) ? args[0] : undefined;
      if (isObject(response) && isObject(response.data)) {
        const commitId = response.data.commitId;
        finish(
          typeof commitId === "string"
            ? { kind: "committed", commitId }
            : { kind: "failed", reason: "protocol" },
        );
        return;
      }
      if (isObject(response) && isObject(response.error)) {
        const name = response.error.name;
        finish({ kind: "rejected", name: typeof name === "string" ? name : "UnknownError" });
        return;
      }
      finish({ kind: "failed", reason: "protocol" });
    };

    try {
      socket = deps.openSocket(SOCKET_URL);
    } catch {
      finish({ kind: "failed", reason: "connect" });
      return;
    }
    socket.addEventListener("message", (event) => {
      // 結果が出た後 (閉じている途中) に届いたものには応えない
      if (!done && typeof event.data === "string") {
        onPacket(event.data);
      }
    });
    // 名前空間に入る前に切れたら接続の失敗、入った後なら途中で切れた
    const onClose = () =>
      finish({ kind: "failed", reason: state === "waiting" ? "closed" : "connect" });
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onClose);
  });
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
