// packages/mobile/tests/socket.test.ts
import { describe, expect, it } from "vitest";
import WebSocketImpl from "ws";
import {
  exportSessionKey,
  generateSessionKey,
  importSessionKey,
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
    while (phoneSocket.ws?.readyState !== 1) {
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
