import { describe, expect, it } from "vitest";
import {
  COMMIT_TIMEOUT_MS,
  type CommitResult,
  SOCKET_URL,
  type SocketLike,
  sendCommit,
} from "../../src/userscript/cosense-socket.ts";

const OPEN =
  '0{"sid":"abc","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}';
const COMMIT = { kind: "page", parentId: "p1", changes: [{ _insert: "_end" }] };

/** 偽の WebSocket。送ったものを記録し、サーバからの受信と切断をテストが起こす */
class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed = 0;
  private readonly listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed++;
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  receive(data: unknown) {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data });
    }
  }

  fire(type: "close" | "error") {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: undefined });
    }
  }
}

function setup(options: { throwOnOpen?: boolean } = {}) {
  const sockets: FakeSocket[] = [];
  const timers = new Map<number, { handler: () => void; ms: number }>();
  let nextTimer = 1;
  const outcome: { result?: CommitResult } = {};
  const promise = sendCommit(COMMIT, {
    openSocket: (url) => {
      if (options.throwOnOpen) {
        throw new Error("CSP");
      }
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimeout: (handler, ms) => {
      timers.set(nextTimer, { handler, ms });
      return nextTimer++;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
  }).then((result) => {
    outcome.result = result;
    return result;
  });
  const socket = () => {
    const found = sockets[0];
    if (found === undefined) throw new Error("開いていない");
    return found;
  };
  /** 0 → 40 まで進める */
  const handshake = () => {
    socket().receive(OPEN);
    socket().receive('40{"sid":"def"}');
  };
  return { promise, sockets, socket, timers, outcome, handshake };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("sendCommit", () => {
  it("**0 → 40 → 42 → 43 の順にやり取りし、commitId を返して閉じる**", async () => {
    const t = setup();
    expect(t.socket().url).toBe(SOCKET_URL);
    expect(SOCKET_URL).toBe("wss://scrapbox.io/socket.io/?EIO=4&transport=websocket");
    // open を待ってから名前空間に入る
    expect(t.socket().sent).toEqual([]);

    t.socket().receive(OPEN);
    expect(t.socket().sent).toEqual(["40"]);

    t.socket().receive('40{"sid":"def"}');
    expect(t.socket().sent).toHaveLength(2);
    const request = t.socket().sent[1] ?? "";
    expect(request).toMatch(/^420\[/);
    expect(JSON.parse(request.slice(3))).toEqual([
      "socket.io-request",
      { method: "commit", data: COMMIT },
    ]);

    t.socket().receive('430[{"data":{"commitId":"c2"}}]');
    expect(await t.promise).toEqual({ kind: "committed", commitId: "c2" });
    expect(t.socket().closed).toBe(1);
    // タイムアウトは止めてある
    expect(t.timers.size).toBe(0);
  });

  it("**サーバの ping (2) に pong (3) を返す** (いつ来ても)", async () => {
    const t = setup();
    t.socket().receive(OPEN);
    t.socket().receive("2");
    t.socket().receive('40{"sid":"def"}');
    t.socket().receive("2");

    expect(t.socket().sent.filter((packet) => packet === "3")).toHaveLength(2);
    expect(t.outcome.result).toBeUndefined();
  });

  it("**エラーの応答はその名前を返す** (NotFastForwardError など)", async () => {
    const t = setup();
    t.handshake();

    t.socket().receive('430[{"error":{"name":"NotFastForwardError","message":"x"}}]');

    expect(await t.promise).toEqual({ kind: "rejected", name: "NotFastForwardError" });
    expect(t.socket().closed).toBe(1);
  });

  it("**ほかの ack の番号・ほかのイベントは無視する**", async () => {
    const t = setup();
    t.handshake();

    t.socket().receive('431[{"data":{"commitId":"other"}}]');
    t.socket().receive('42["commit",{"kind":"page"}]');
    t.socket().receive("6");
    await settle();
    expect(t.outcome.result).toBeUndefined();

    t.socket().receive('430[{"data":{"commitId":"c3"}}]');
    expect(await t.promise).toEqual({ kind: "committed", commitId: "c3" });
  });

  it("**応答が無ければタイムアウトで閉じる**", async () => {
    const t = setup();
    t.handshake();
    const [timer] = [...t.timers.values()];
    expect(timer?.ms).toBe(COMMIT_TIMEOUT_MS);

    timer?.handler();

    expect(await t.promise).toEqual({ kind: "failed", reason: "timeout" });
    expect(t.socket().closed).toBe(1);
  });

  it("**名前空間に入れなければ接続の失敗** (CONNECT_ERROR・入る前に切れた・開けない)", async () => {
    const refused = setup();
    refused.socket().receive(OPEN);
    refused.socket().receive('44{"message":"unauthorized"}');
    expect(await refused.promise).toEqual({ kind: "failed", reason: "connect" });

    const dropped = setup();
    dropped.socket().fire("error");
    expect(await dropped.promise).toEqual({ kind: "failed", reason: "connect" });

    const blocked = setup({ throwOnOpen: true });
    expect(await blocked.promise).toEqual({ kind: "failed", reason: "connect" });
    expect(blocked.timers.size).toBe(0);
  });

  it("**送った後に切れたら closed** (サーバの close・DISCONNECT・WebSocket の close)", async () => {
    for (const end of ["1", "41", "close"] as const) {
      const t = setup();
      t.handshake();

      if (end === "close") {
        t.socket().fire("close");
      } else {
        t.socket().receive(end);
      }

      expect(await t.promise).toEqual({ kind: "failed", reason: "closed" });
    }
  });

  it("**相手が socket.io でなければ protocol** (open の中身・応答の形が違う)", async () => {
    const notOpen = setup();
    notOpen.socket().receive("0not-json");
    expect(await notOpen.promise).toEqual({ kind: "failed", reason: "protocol" });
    expect(notOpen.socket().sent).toEqual([]);

    const strange = setup();
    strange.handshake();
    strange.socket().receive('430[{"data":{}}]');
    expect(await strange.promise).toEqual({ kind: "failed", reason: "protocol" });
  });

  it("**結果が出た後の受信では何も送らず、結果も変えない**", async () => {
    const t = setup();
    t.handshake();
    t.socket().receive('430[{"data":{"commitId":"c2"}}]');
    await t.promise;
    const sent = t.socket().sent.length;

    t.socket().receive('430[{"error":{"name":"NotFastForwardError"}}]');
    t.socket().receive("2");
    t.socket().fire("close");

    expect(t.outcome.result).toEqual({ kind: "committed", commitId: "c2" });
    expect(t.socket().closed).toBe(1);
    expect(t.socket().sent).toHaveLength(sent);
  });
});
