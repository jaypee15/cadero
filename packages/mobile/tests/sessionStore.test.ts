// packages/mobile/tests/sessionStore.test.ts
import { afterEach, describe, expect, it } from "vitest";
import WebSocketImpl from "ws";
import { generateSessionKey, type WireEvent } from "@cadero/protocol";
import { createServer } from "@cadero/relay/server.js";
import { createRoomStore } from "@cadero/relay/rooms.js";
import { MobileSocket, type MobileSocketOptions } from "../src/realtime/socket.js";
import {
  createSessionStore,
  SESSIONS_STORAGE_KEY,
  type SessionStore,
  type SocketLike,
} from "../src/state/sessionStore.js";

const redisUrl = "redis://127.0.0.1:6379";

const KEY_43 = "A".repeat(43);

async function newRoom(): Promise<string> {
  const rooms = createRoomStore(redisUrl);
  const roomId = await rooms.createRoom();
  rooms.disconnect();
  return roomId;
}

async function spinRelay(): Promise<{ relayUrl: string; close(): Promise<void> }> {
  const app = createServer({ redisUrl, verifyUser: async () => "phone" });
  await app.listen({ port: 0 });
  const port = (app.server.address() as { port: number }).port;
  return {
    relayUrl: `http://127.0.0.1:${port}`,
    close: () => app.close(),
  };
}

// A MobileSocket doubles as the CLI-side peer in these tests: it joins the
// same room and publishes encrypted frames the store must decrypt.
function makePeer(relayUrl: string, roomId: string, sessionKey: CryptoKey) {
  let socket: MobileSocket | undefined;
  return {
    async connect(): Promise<void> {
      socket = new MobileSocket({
        relayUrl,
        roomId,
        token: "t",
        sessionKey,
        WebSocketImpl: WebSocketImpl as unknown as typeof WebSocket,
        onEvent: () => {},
        onGap: () => {},
        onClosed: () => {},
      });
      await socket.connect();
    },
    send(event: WireEvent): Promise<void> {
      if (!socket) return Promise.reject(new Error("peer not connected"));
      return socket.send(event);
    },
    close(): Promise<void> {
      return socket?.close() ?? Promise.resolve();
    },
  };
}

// Store-side factory that mirrors production (real MobileSocket) but injects
// the node ws implementation, since jsdom has no usable WebSocket.
function realFactory() {
  return (opts: MobileSocketOptions): SocketLike =>
    new MobileSocket({ ...opts, WebSocketImpl: WebSocketImpl as unknown as typeof WebSocket });
}

interface FakeHandle {
  socket: SocketLike & { connected: boolean; closed: boolean };
  opts: MobileSocketOptions;
  sent: WireEvent[];
}

function fakeFactory() {
  const created: FakeHandle[] = [];
  const factory = (opts: MobileSocketOptions): SocketLike => {
    const handle: FakeHandle = {
      opts,
      sent: [],
      socket: {
        connected: false,
        closed: false,
        connect: () => {
          handle.socket.connected = true;
          return Promise.resolve();
        },
        send: (event: WireEvent) => {
          handle.sent.push(event);
          return Promise.resolve();
        },
        close: () => {
          handle.socket.closed = true;
          return Promise.resolve();
        },
      },
    };
    created.push(handle);
    return handle.socket;
  };
  return { factory, created };
}

function fakeSocket(): SocketLike {
  return {
    connect: () => Promise.resolve(),
    send: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

function snapshot(store: SessionStore) {
  return store.getSnapshot();
}

async function waitForTerminal(
  store: SessionStore,
  roomId: string,
  text: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rt = store.getSnapshot().sessions.find((s) => s.roomId === roomId);
    if (rt?.terminal.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`terminal for ${roomId} never contained ${JSON.stringify(text)}`);
}

afterEach(() => {
  sessionStorage.clear();
});

describe("createSessionStore (fake sockets)", () => {
  function makeStore(extra: Partial<Parameters<typeof createSessionStore>[0]> = {}) {
    const { factory, created } = fakeFactory();
    const store = createSessionStore({ socketFactory: factory, ...extra });
    return { store, created };
  }

  it("starts empty with no active session", () => {
    const { store } = makeStore();
    expect(snapshot(store).sessions).toEqual([]);
    expect(snapshot(store).activeId).toBeNull();
  });

  it("addSession connects a socket, activates it, and routes terminal events into the buffer", async () => {
    const { store, created } = makeStore();
    await store.addSession({ relay: "http://r", room: "room_aaaa", key: KEY_43 }, "tok");
    expect(created).toHaveLength(1);
    expect(created[0].socket.connected).toBe(true);
    expect(created[0].opts.roomId).toBe("room_aaaa");
    expect(created[0].opts.token).toBe("tok");

    created[0].opts.onEvent({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_cli" },
      payload: { chunk: "hello phone" },
    });
    const view = snapshot(store);
    expect(view.activeId).toBe("room_aaaa");
    expect(view.sessions).toHaveLength(1);
    expect(view.sessions[0].phase).toBe("live");
    expect(view.sessions[0].terminal).toContain("hello phone");
    expect(view.sessions[0].chunkCount).toBe(1);
  });

  it("uses the pairing label when given, falling back to Room <last4>", async () => {
    const { store } = makeStore();
    await store.addSession(
      { relay: "http://r", room: "room_aaaa111122223333", key: KEY_43, label: "claude · cadence" },
      "tok",
    );
    expect(snapshot(store).sessions[0].label).toBe("claude · cadence");

    await store.addSession({ relay: "http://r", room: "room_bbbb111122223333", key: KEY_43 }, "tok");
    expect(snapshot(store).sessions[1].label).toBe("Room 3333");

    // Labels survive persistence.
    store.setActive("room_aaaa111122223333");
    const store2 = createSessionStore({ socketFactory: () => fakeSocket() });
    sessionStorage.setItem("cadero_oauth_token", "tok");
    await store2.restore();
    expect(snapshot(store2).sessions.find((s) => s.roomId === "room_aaaa111122223333")!.label).toBe(
      "claude · cadence",
    );
  });

  it("on gap clears the stale view (catch-up replaces it) and clears gapped when data flows again", async () => {
    const { store, created } = makeStore();
    await store.addSession({ relay: "http://r", room: "room_aaaa", key: KEY_43 }, "tok");
    created[0].opts.onEvent({
      event: "TERMINAL_DATA",
      meta: { session_id: "s" },
      payload: { chunk: "before the gap" },
    });
    created[0].opts.onGap();
    // The stale buffer is wiped (the daemon's scrollback replay replaces it);
    // the gap banner carries the "output was lost" signal instead.
    expect(snapshot(store).sessions[0].terminal).toBe("");
    expect(snapshot(store).sessions[0].gapped).toBe(true);
    created[0].opts.onEvent({
      event: "TERMINAL_DATA",
      meta: { session_id: "s" },
      payload: { chunk: "back" },
    });
    expect(snapshot(store).sessions[0].gapped).toBe(false);
  });

  it("closes the socket and marks the session closed on SESSION_ENDED", async () => {
    const { store, created } = makeStore();
    await store.addSession({ relay: "http://r", room: "room_aaaa", key: KEY_43 }, "tok");
    created[0].opts.onEvent({
      event: "SESSION_ENDED",
      meta: { session_id: "s" },
      payload: { code: 0, reason: "agent exited" },
    });
    const view = snapshot(store);
    expect(view.sessions[0].phase).toBe("closed");
    expect(view.sessions[0].closedReason).toContain("agent exited");
    expect(created[0].socket.closed).toBe(true);
  });

  it("ignores late events after the session closed", async () => {
    const { store, created } = makeStore();
    await store.addSession({ relay: "http://r", room: "room_aaaa", key: KEY_43 }, "tok");
    created[0].opts.onEvent({
      event: "SESSION_ENDED",
      meta: { session_id: "s" },
      payload: { code: 0, reason: "agent exited" },
    });
    created[0].opts.onEvent({
      event: "TERMINAL_DATA",
      meta: { session_id: "s" },
      payload: { chunk: "late" },
    });
    expect(snapshot(store).sessions[0].terminal).not.toContain("late");
  });

  it("marks fatal on a decryption mismatch", async () => {
    const { store, created } = makeStore();
    await store.addSession({ relay: "http://r", room: "room_aaaa", key: KEY_43 }, "tok");
    created[0].opts.onFatal?.({ reason: "decryption_failed" } as never);
    expect(snapshot(store).sessions[0].phase).toBe("closed");
    expect(snapshot(store).sessions[0].closedReason).toContain("pairing mismatch");
  });

  it("removeSession closes the socket and drops the record", async () => {
    const { store, created } = makeStore();
    await store.addSession({ relay: "http://r", room: "room_aaaa", key: KEY_43 }, "tok");
    store.removeSession("room_aaaa");
    expect(created[0].socket.closed).toBe(true);
    expect(snapshot(store).sessions).toEqual([]);
    expect(snapshot(store).activeId).toBeNull();
  });

  it("persists sessions to storage and restore() reconnects them", async () => {
    const { store, created } = makeStore();
    await store.addSession({ relay: "http://r", room: "room_aaaa", key: KEY_43 }, "tok");
    created[0].opts.onEvent({
      event: "TERMINAL_DATA",
      meta: { session_id: "s" },
      payload: { chunk: "buffered output" },
    });

    const raw = sessionStorage.getItem(SESSIONS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!) as Array<{ roomId: string; terminal: string; key: string }>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0].roomId).toBe("room_aaaa");
    expect(persisted[0].terminal).toContain("buffered output");
    expect(persisted[0].key).toBe(KEY_43);

    sessionStorage.setItem("cadero_oauth_token", "tok");
    const { factory: factory2, created: created2 } = fakeFactory();
    const store2 = createSessionStore({ socketFactory: factory2 });
    await store2.restore();
    const view = snapshot(store2);
    expect(view.sessions).toHaveLength(1);
    expect(view.sessions[0].roomId).toBe("room_aaaa");
    // The restored buffer is replaced by the daemon's catch-up replay: the
    // restore must have requested it.
    expect(created2[0].sent.some((s) => s.event === "TERMINAL_CATCHUP_REQUEST")).toBe(true);
    expect(view.sessions[0].phase).toBe("live");
    expect(created2).toHaveLength(1);
    expect(created2[0].socket.connected).toBe(true);
  });

  it("does not reconnect closed sessions on restore", async () => {
    const { store, created } = makeStore();
    await store.addSession({ relay: "http://r", room: "room_aaaa", key: KEY_43 }, "tok");
    created[0].opts.onEvent({
      event: "SESSION_ENDED",
      meta: { session_id: "s" },
      payload: { code: 0, reason: "agent exited" },
    });

    const { factory: factory2, created: created2 } = fakeFactory();
    const store2 = createSessionStore({ socketFactory: factory2 });
    await store2.restore();
    expect(snapshot(store2).sessions[0].phase).toBe("closed");
    expect(created2).toHaveLength(0);
  });

  it("caps the persisted terminal buffer", async () => {
    const { store, created } = makeStore({ persistTerminalLimit: 10 });
    await store.addSession({ relay: "http://r", room: "room_aaaa", key: KEY_43 }, "tok");
    created[0].opts.onEvent({
      event: "TERMINAL_DATA",
      meta: { session_id: "s" },
      payload: { chunk: "x".repeat(50) },
    });
    const persisted = JSON.parse(
      sessionStorage.getItem(SESSIONS_STORAGE_KEY)!,
    ) as Array<{ terminal: string }>;
    expect(persisted[0].terminal.length).toBeLessThanOrEqual(10);
  });

  it("raise-and-resolve intercepts against the active session", async () => {
    const { store, created } = makeStore();
    await store.addSession({ relay: "http://r", room: "room_aaaa", key: KEY_43 }, "tok");
    created[0].opts.onEvent({
      event: "INTERCEPT_REQUIRED",
      meta: { session_id: "sess_1", timestamp: 42 },
      payload: { agent: "claude", reason: "EXECUTE_COMMAND", command: "rm -rf ./dist" },
    });
    expect(snapshot(store).sessions[0].intercept).toEqual({
      id: "sess_1:42",
      agent: "claude",
      command: "rm -rf ./dist",
    });
    await store.resolve("APPROVE");
    expect(snapshot(store).sessions[0].intercept).toBeNull();
  });

  it("sendResize reaches the active session's socket with the stored dimensions", async () => {
    const { store, created } = makeStore();
    await store.addSession({ relay: "http://r", room: "room_aaaa", key: KEY_43 }, "tok");
    await store.addSession({ relay: "http://r", room: "room_bbbb", key: KEY_43 }, "tok");
    store.setTermDims({ cols: 80, rows: 24 });
    await store.sendResize();
    expect(
      created[1].sent.some(
        (s) => s.event === "TERMINAL_RESIZE" && (s.payload as { cols: number }).cols === 80,
      ),
    ).toBe(true);
    // The background session got its join-time frames but no resize.
    expect(created[0].sent.some((s) => s.event === "TERMINAL_RESIZE")).toBe(false);
  });

  it("sends a catch-up request on join and on gap, clearing the local view first", async () => {
    const { store, created } = makeStore();
    const sinkChunks: string[] = [];
    let cleared = 0;
    store.setSink({
      write: (chunk) => sinkChunks.push(chunk),
      clear: () => {
        cleared += 1;
        sinkChunks.length = 0;
      },
    });
    await store.addSession({ relay: "http://r", room: "room_aaaa", key: KEY_43 }, "tok");
    // Fresh join: the catch-up request rides along with the resize.
    expect(created[0].sent.some((s) => s.event === "TERMINAL_CATCHUP_REQUEST")).toBe(true);

    created[0].opts.onEvent({
      event: "TERMINAL_DATA",
      meta: { session_id: "s" },
      payload: { chunk: "live output" },
    });
    expect(snapshot(store).sessions[0].terminal).toContain("live output");

    // Gap: the store clears the local view (so the replay replaces it) and
    // asks the daemon to replay its scrollback. (The join-time catch-up also
    // cleared once, so the counter reads 2 here.)
    created[0].opts.onGap();
    expect(cleared).toBe(2);
    expect(created[0].sent.filter((s) => s.event === "TERMINAL_CATCHUP_REQUEST")).toHaveLength(2);
    expect(snapshot(store).sessions[0].terminal).toBe("");

    // The replay arrives and repopulates the view.
    created[0].opts.onEvent({
      event: "TERMINAL_DATA",
      meta: { session_id: "s" },
      payload: { chunk: "replayed scrollback" },
    });
    expect(snapshot(store).sessions[0].terminal).toContain("replayed scrollback");
  });

  it("counts every received frame (heartbeats included) for the debug strip", async () => {
    const { store, created } = makeStore();
    await store.addSession({ relay: "http://r", room: "room_aaaa", key: KEY_43 }, "tok");
    expect(snapshot(store).sessions[0].rxCount).toBe(0);
    created[0].opts.onEvent({
      event: "HEARTBEAT",
      meta: { session_id: "s" },
      payload: {},
    });
    expect(snapshot(store).sessions[0].rxCount).toBe(1);
    created[0].opts.onEvent({
      event: "TERMINAL_DATA",
      meta: { session_id: "s" },
      payload: { chunk: "x" },
    });
    expect(snapshot(store).sessions[0].rxCount).toBe(2);
    expect(snapshot(store).sessions[0].chunkCount).toBe(1);
  });

  it("streams the active session's chunks to the sink, background sessions stay out", async () => {
    const { store, created } = makeStore();
    const sink: string[] = [];
    store.setSink({ write: (chunk) => sink.push(chunk), clear: () => {} });
    await store.addSession({ relay: "http://r", room: "room_aaaa", key: KEY_43 }, "tok");
    created[0].opts.onEvent({
      event: "TERMINAL_DATA",
      meta: { session_id: "s" },
      payload: { chunk: "foreground" },
    });
    expect(sink).toContain("foreground");

    await store.addSession({ relay: "http://r", room: "room_bbbb", key: KEY_43 }, "tok");
    // addSession switches the active session to room_bbbb.
    created[0].opts.onEvent({
      event: "TERMINAL_DATA",
      meta: { session_id: "s" },
      payload: { chunk: "now-background" },
    });
    expect(sink).not.toContain("now-background");
    expect(snapshot(store).sessions[0].terminal).toContain("now-background");

    created[1].opts.onEvent({
      event: "TERMINAL_DATA",
      meta: { session_id: "s" },
      payload: { chunk: "now-foreground" },
    });
    expect(sink).toContain("now-foreground");
  });
});

describe("createSessionStore (real relay, multi-socket)", () => {
  it("keeps every paired room connected and buffers background output", async () => {
    const relay = await spinRelay();
    const roomA = await newRoom();
    const roomB = await newRoom();
    const store = createSessionStore({ socketFactory: realFactory() });

    const { generateSessionKey, exportSessionKey } = await import("@cadero/protocol");
    const keyA = await generateSessionKey();
    const keyB = await generateSessionKey();
    const [rawA, rawB] = [await exportSessionKey(keyA), await exportSessionKey(keyB)];

    const peerA = makePeer(relay.relayUrl, roomA, keyA);
    const peerB = makePeer(relay.relayUrl, roomB, keyB);
    await store.addSession({ relay: relay.relayUrl, room: roomA, key: rawA }, "t");
    await store.addSession({ relay: relay.relayUrl, room: roomB, key: rawB }, "t");

    await peerA.connect();
    await peerB.connect();

    // B receives while A is active: B buffers in the background.
    await peerB.send({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_b" },
      payload: { chunk: "background output" },
    });
    await waitForTerminal(store, roomB, "background output");
    const view = snapshot(store);
    const sessA = view.sessions.find((s) => s.roomId === roomA)!;
    const sessB = view.sessions.find((s) => s.roomId === roomB)!;
    expect(sessA.phase).toBe("live");
    expect(sessB.phase).toBe("live");
    expect(sessA.terminal).not.toContain("background output");

    // A also keeps receiving while B is active after the switch.
    store.setActive(roomB);
    await peerA.send({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_a" },
      payload: { chunk: "foreground output" },
    });
    await waitForTerminal(store, roomA, "foreground output");
    const view2 = snapshot(store);
    expect(view2.sessions.find((s) => s.roomId === roomA)!.terminal).toContain(
      "foreground output",
    );

    await peerA.close();
    await peerB.close();
    await relay.close();
  }, 30000);
});
