// packages/mobile/tests/socket.test.ts
import { describe, expect, it } from "vitest";
import WebSocketImpl from "ws";
import {
  decryptEnvelope,
  generateSessionKey,
} from "@cadero/protocol";
import { createServer } from "@cadero/relay/server.js";
import { createRoomStore } from "@cadero/relay/rooms.js";
import { MobileSocket, HEARTBEAT_INTERVAL_MS, STALE_AFTER_MS } from "../src/realtime/socket.js";

const redisUrl = "redis://127.0.0.1:6379";

function onceEvent(socket: MobileSocket): Promise<unknown> {
  return new Promise((resolve) => {
    const prev = socket.onEvent.bind(socket);
    socket.onEvent = (event) => {
      prev(event);
      resolve(event);
    };
  });
}

describe("MobileSocket against the real relay", () => {
  it("sends and receives decrypted events, marks gaps on reconnect", async () => {
    const store = createRoomStore(redisUrl);
    const roomId = await store.createRoom();
    store.disconnect();

    const app = createServer({ redisUrl, verifyUser: async () => "phone" });
    await app.listen({ port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const relayUrl = `http://127.0.0.1:${port}`;

    const sessionKey = await generateSessionKey();
    let gaps = 0;
    const phone = new MobileSocket({
      relayUrl,
      roomId,
      token: "t",
      sessionKey,
      WebSocketImpl: WebSocketImpl as unknown as typeof WebSocket,
      onEvent: () => {},
      onGap: () => {
        gaps += 1;
      },
      onClosed: () => {},
    });
    const opened = phone.connect();
    const cli = new MobileSocket({
      relayUrl,
      roomId,
      token: "t",
      sessionKey,
      WebSocketImpl: WebSocketImpl as unknown as typeof WebSocket,
      onEvent: () => {},
      onGap: () => {},
      onClosed: () => {},
    });
    await Promise.all([opened, cli.connect()]);

    const received = onceEvent(phone);
    await cli.send({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_cli" },
      payload: { chunk: "hello phone" },
    });
    expect(await received).toEqual({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_cli", timestamp: expect.any(Number) },
      payload: { chunk: "hello phone" },
    });

    // Drop the relay, bring it back on the same port: the phone reconnects
    // and onGap fired exactly once for the lost window.
    await app.close();
    const app2 = createServer({ redisUrl, verifyUser: async () => "phone" });
    await app2.listen({ port });
    const back = onceEvent(phone);
    await new Promise((r) => setTimeout(r, 2500));
    await cli.send({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_cli" },
      payload: { chunk: "after gap" },
    });
    expect(await back).toEqual({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_cli", timestamp: expect.any(Number) },
      payload: { chunk: "after gap" },
    });
    expect(gaps).toBe(1);

    await phone.close();
    await cli.close();
    await app2.close();
  }, 30000);

  it("sends heartbeats and survives a relay outage window", async () => {
    const store = createRoomStore(redisUrl);
    const roomId = await store.createRoom();
    store.disconnect();

    const app = createServer({ redisUrl, verifyUser: async () => "phone" });
    await app.listen({ port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const relayUrl = `http://127.0.0.1:${port}`;

    const sessionKey = await generateSessionKey();
    const phone = new MobileSocket({
      relayUrl,
      roomId,
      token: "t",
      sessionKey,
      WebSocketImpl: WebSocketImpl as unknown as typeof WebSocket,
      onEvent: () => {},
      onGap: () => {},
      onClosed: () => {},
    });
    await phone.connect();
    await app.close();
    await new Promise((r) => setTimeout(r, 3000));
    const app2 = createServer({ redisUrl, verifyUser: async () => "phone" });
    await app2.listen({ port });
    // The relay has no replay (redis pub/sub only reaches subscribed members),
    // so wait for the phone's backoff-driven reconnect to land before the peer
    // sends; otherwise the single heartbeat is lost mid-outage.
    const phoneSocket = phone as unknown as { ws?: { readyState: number } };
    // Internal deadline: a poll that never lands must fail fast, not hang
    // until the suite timeout.
    const reconnectDeadline = Date.now() + 20000;
    while (phoneSocket.ws?.readyState !== 1) {
      if (Date.now() > reconnectDeadline) {
        throw new Error("socket never reconnected (internal deadline)");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const back = onceEvent(phone);
    const cli = new MobileSocket({
      relayUrl,
      roomId,
      token: "t",
      sessionKey,
      WebSocketImpl: WebSocketImpl as unknown as typeof WebSocket,
      onEvent: () => {},
      onGap: () => {},
      onClosed: () => {},
    });
    await cli.connect();
    await cli.send({
      event: "HEARTBEAT",
      meta: { session_id: "sess_cli" },
      payload: {},
    });
    expect(await back).toEqual({
      event: "HEARTBEAT",
      meta: { session_id: "sess_cli", timestamp: expect.any(Number) },
      payload: {},
    });
    await phone.close();
    await cli.close();
    await app2.close();
  }, 30000);
});

describe("onFatal wrong-key close path", () => {
  it("fires onFatal, closes, and never reconnects when paired with the wrong key", async () => {
    const store = createRoomStore(redisUrl);
    const roomId = await store.createRoom();
    store.disconnect();

    const app = createServer({ redisUrl, verifyUser: async () => "phone" });
    await app.listen({ port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const relayUrl = `http://127.0.0.1:${port}`;

    const sessionKey = await generateSessionKey();
    const cli = new MobileSocket({
      relayUrl,
      roomId,
      token: "t",
      sessionKey,
      WebSocketImpl: WebSocketImpl as unknown as typeof WebSocket,
      onEvent: () => {},
      onGap: () => {},
      onClosed: () => {},
    });
    await cli.connect();

    // The phone paired with a DIFFERENT key: the peer's frame cannot decrypt.
    const events: unknown[] = [];
    let fatalCount = 0;
    const phone = new MobileSocket({
      relayUrl,
      roomId,
      token: "t",
      sessionKey: await generateSessionKey(),
      WebSocketImpl: WebSocketImpl as unknown as typeof WebSocket,
      onEvent: (event) => {
        events.push(event);
      },
      onGap: () => {},
      onClosed: () => {},
      onFatal: () => {
        fatalCount += 1;
      },
    });
    await phone.connect();

    await cli.send({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_cli" },
      payload: { chunk: "hello" },
    });

    const deadline = Date.now() + 5000;
    while (fatalCount === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(fatalCount).toBe(1);
    expect(events).toHaveLength(0);

    // No reconnect: give any (wrongly scheduled) backoff reconnect ample
    // time, then confirm the socket stays down and silent.
    await new Promise((r) => setTimeout(r, 2500));
    const ws = (phone as unknown as { ws?: { readyState: number } }).ws;
    expect(ws === undefined || ws.readyState === 3).toBe(true);

    await cli.close();
    await app.close();
  }, 30000);
});

describe("envelope header stamping", () => {
  it("stamps a stable per-instance sender and a monotonic seq on every frame", async () => {
    const sent: string[] = [];
    const sessionKey = await generateSessionKey();
    const phone = new MobileSocket({
      relayUrl: "http://127.0.0.1:1",
      roomId: "room_x",
      token: "t",
      sessionKey,
      WebSocketImpl: class {
        readyState = 1;
        onopen: (() => void) | undefined;
        onclose: (() => void) | undefined;
        onmessage: ((m: { data: string }) => void) | undefined;
        constructor(_url: string) {
          setTimeout(() => this.onopen?.(), 0);
        }
        send(raw: string) {
          sent.push(raw);
        }
        addEventListener() {}
        close() {}
      } as unknown as typeof WebSocket,
      onEvent: () => {},
      onGap: () => {},
      onClosed: () => {},
    });
    await phone.connect();
    await phone.send({
      event: "TERMINAL_RESIZE",
      meta: { session_id: "mobile" },
      payload: { cols: 80, rows: 24 },
    });
    await phone.send({
      event: "EXECUTE_AGENT_PROMPT",
      meta: { session_id: "mobile" },
      payload: { prompt: "hi" },
    });
    expect(sent).toHaveLength(2);
    const first = JSON.parse(sent[0]);
    const second = JSON.parse(sent[1]);
    expect(first.sender).toBeTruthy();
    expect(second.sender).toBe(first.sender);
    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
    // The encrypted payload still round-trips with the header attached.
    const back = await decryptEnvelope(sessionKey, first);
    expect(back).toEqual({
      event: "TERMINAL_RESIZE",
      meta: { session_id: "mobile", timestamp: expect.any(Number) },
      payload: { cols: 80, rows: 24 },
    });
  });
});

describe("staleness detection", () => {
  it("exports the documented heartbeat cadero", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(20000);
    expect(STALE_AFTER_MS).toBe(45000);
  });

  function makeTestSocket(): {
    internals: {
      ws: { readyState: number; close: () => void } | undefined;
      lastReceivedAt: number;
      closedByUser: boolean;
      maybeForceReconnect?: () => void;
    };
    closes: number[];
  } {
    const socket = new MobileSocket({
      relayUrl: "http://127.0.0.1:1",
      roomId: "room_test",
      token: "t",
      sessionKey: null as unknown as CryptoKey,
      onEvent: () => {},
      onGap: () => {},
      onClosed: () => {},
    });
    const closes: number[] = [];
    const internals = socket as unknown as {
      ws: { readyState: number; close: () => void } | undefined;
      lastReceivedAt: number;
      closedByUser: boolean;
      maybeForceReconnect?: () => void;
    };
    internals.ws = {
      readyState: 1,
      close: () => {
        closes.push(1);
      },
    };
    return { internals, closes };
  }

  it("force-closes a silent-but-open socket so the reconnect path takes over", () => {
    const { internals, closes } = makeTestSocket();
    expect(typeof internals.maybeForceReconnect).toBe("function");
    internals.lastReceivedAt = Date.now() - STALE_AFTER_MS - 1;
    internals.maybeForceReconnect!();
    expect(closes).toHaveLength(1);
  });

  it("leaves fresh, not-open, or user-closed sockets alone", () => {
    const { internals, closes } = makeTestSocket();
    internals.lastReceivedAt = Date.now();
    internals.maybeForceReconnect!();
    expect(closes).toHaveLength(0);

    internals.lastReceivedAt = Date.now() - STALE_AFTER_MS - 1;
    internals.ws = undefined;
    internals.maybeForceReconnect!();
    expect(closes).toHaveLength(0);

    internals.ws = { readyState: 1, close: () => closes.push(1) };
    internals.closedByUser = true;
    internals.maybeForceReconnect!();
    expect(closes).toHaveLength(0);
  });
});
