// packages/mobile/tests/socket.test.ts
import { describe, expect, it } from "vitest";
import WebSocketImpl from "ws";
import {
  exportSessionKey,
  generateSessionKey,
  importSessionKey,
} from "@cadence/protocol";
import { createServer } from "@cadence/relay/server.js";
import { createRoomStore } from "@cadence/relay/rooms.js";
import { MobileSocket } from "../src/realtime/socket.js";

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
});
