import { describe, expect, it } from "vitest";
import {
  exportSessionKey,
  generateSessionKey,
  importSessionKey,
} from "@cadero/protocol";
import { createServer } from "@cadero/relay/server.js";
import { createRoomStore } from "@cadero/relay/rooms.js";
import { CaderoSocket, HEARTBEAT_INTERVAL_MS, STALE_AFTER_MS } from "../src/socket.js";

const redisUrl = "redis://127.0.0.1:6379";

function onceEvent(socket: CaderoSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.onEvent((event) => resolve(event));
  });
}

describe("CaderoSocket against the real relay", () => {
  it("sends and receives decrypted wire events and reconnects after drop", async () => {
    const store = createRoomStore(redisUrl);
    const roomId = await store.createRoom();
    store.disconnect();

    const app = createServer({ redisUrl, verifyUser: async () => "cli" });
    await app.listen({ port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const relayUrl = `http://127.0.0.1:${port}`;

    const sessionKey = await generateSessionKey();
    const cli = new CaderoSocket({
      relayUrl,
      roomId,
      token: "t",
      sessionKey,
      sessionId: "sess_cli",
    });
    await cli.connect();

    // A peer (the "phone" role) joins with its own import of the same key.
    const rawKey = await importSessionKey(await exportSessionKey(sessionKey));
    const phone = new CaderoSocket({
      relayUrl,
      roomId,
      token: "t",
      sessionKey: rawKey,
      sessionId: "sess_phone",
    });
    const received = onceEvent(phone);
    await phone.connect();

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

    // Phone -> CLI direction.
    const cliReceived = onceEvent(cli);
    await phone.send({
      event: "RESOLVE_INTERCEPT",
      meta: { session_id: "sess_cli" },
      payload: { decision: "APPROVE", input_payload: null },
    });
    expect(await cliReceived).toEqual({
      event: "RESOLVE_INTERCEPT",
      meta: { session_id: "sess_cli", timestamp: expect.any(Number) },
      payload: { decision: "APPROVE", input_payload: null },
    });

    // Reconnect: closing the relay kills sockets; CaderoSocket retries
    // with backoff and rejoins a restarted relay on the same port.
    await app.close();
    const app2 = createServer({ redisUrl, verifyUser: async () => "cli" });
    await app2.listen({ port });
    const back = onceEvent(cli);
    await new Promise((r) => setTimeout(r, 2500));
    await phone.send({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_phone" },
      payload: { chunk: "after reconnect" },
    });
    expect(await back).toEqual({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_phone", timestamp: expect.any(Number) },
      payload: { chunk: "after reconnect" },
    });

    await cli.close();
    await phone.close();
    await app2.close();
  }, 30000);

  it("sends heartbeats and reconnects when the peer goes silent", async () => {
    const store = createRoomStore(redisUrl);
    const roomId = await store.createRoom();
    store.disconnect();

    const app = createServer({ redisUrl, verifyUser: async () => "cli" });
    await app.listen({ port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const relayUrl = `http://127.0.0.1:${port}`;

    const sessionKey = await generateSessionKey();
    const cli = new CaderoSocket({
      relayUrl,
      roomId,
      token: "t",
      sessionKey,
      sessionId: "sess_cli",
    });
    await cli.connect();

    // The relay echoes nothing back to the sender (no-echo), so CLI receives
    // nothing by default; heartbeats flow every HEARTBEAT_INTERVAL_MS and the
    // staleness timer must NOT fire while heartbeats are received.
    // Force staleness by closing the relay without restarting it: the socket
    // should reconnect on its own schedule regardless.
    await app.close();
    // Without a restarted relay, connection attempts fail; the socket keeps
    // retrying. Assert it survives 3 seconds without crashing (heartbeat
    // timers cleared while closed; no unhandled rejections).
    await new Promise((r) => setTimeout(r, 3000));
    const app2 = createServer({ redisUrl, verifyUser: async () => "cli" });
    await app2.listen({ port });
    // The CLI reconnects on its own backoff schedule and the relay has no
    // replay, so wait for it to be back on the wire before the phone sends.
    const cliSocket = cli as unknown as { ws?: { readyState: number } };
    while (cliSocket.ws?.readyState !== 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const back = onceEvent(cli);
    const phone = new CaderoSocket({
      relayUrl,
      roomId,
      token: "t",
      sessionKey,
      sessionId: "sess_phone",
    });
    await phone.connect();
    // A HEARTBEAT from the phone arrives as a decrypted event.
    await phone.send({
      event: "HEARTBEAT",
      meta: { session_id: "sess_phone" },
      payload: {},
    });
    expect(await back).toEqual({
      event: "HEARTBEAT",
      meta: { session_id: "sess_phone", timestamp: expect.any(Number) },
      payload: {},
    });

    await cli.close();
    await phone.close();
    await app2.close();
  }, 30000);
});

describe("envelope header stamping", () => {
  it("stamps a stable per-instance sender and a monotonic seq on every frame", async () => {
    const store = createRoomStore(redisUrl);
    const roomId = await store.createRoom();
    store.disconnect();

    const app = createServer({ redisUrl, verifyUser: async () => "cli" });
    await app.listen({ port: 0 });
    const port = (app.server.address() as { port: number }).port;

    const sessionKey = await generateSessionKey();
    const cli = new CaderoSocket({
      relayUrl: `http://127.0.0.1:${port}`,
      roomId,
      token: "t",
      sessionKey,
      sessionId: "sess_cli",
    });
    await cli.connect();

    const { default: WebSocket } = await import("ws");
    const sent: string[] = [];
    const phone = new WebSocket(`ws://127.0.0.1:${port}/v1/stream?room_id=${roomId}&token=t2`);
    await new Promise((resolve) => phone.once("open", resolve));
    phone.on("message", (data) => sent.push(data.toString()));

    await cli.send({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_cli" },
      payload: { chunk: "one" },
    });
    await cli.send({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_cli" },
      payload: { chunk: "two" },
    });
    const envelopes = await new Promise<string[]>((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => {
        if (sent.length >= 2) return resolve(sent.splice(0));
        if (Date.now() > deadline) return reject(new Error("no frames received"));
        setTimeout(poll, 50);
      };
      poll();
    });
    expect(envelopes).toHaveLength(2);
    const first = JSON.parse(envelopes[0]);
    const second = JSON.parse(envelopes[1]);
    expect(first.sender).toBeTruthy();
    expect(second.sender).toBe(first.sender);
    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);

    await cli.close();
    phone.close();
    await app.close();
  }, 15000);
});

describe("staleness detection", () => {
  it("exports the documented heartbeat cadero", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(20000);
    expect(STALE_AFTER_MS).toBe(45000);
  });

  function makeTestSocket(): {
    socket: CaderoSocket;
    internals: {
      ws: { readyState: number; close: () => void } | undefined;
      lastReceivedAt: number;
      closedByUser: boolean;
      maybeForceReconnect?: () => void;
    };
    closes: number[];
  } {
    const socket = new CaderoSocket({
      relayUrl: "http://127.0.0.1:1",
      roomId: "room_test",
      token: "t",
      sessionKey: null as unknown as CryptoKey,
      sessionId: "sess_test",
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
    return { socket, internals, closes };
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
