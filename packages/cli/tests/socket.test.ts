import { describe, expect, it } from "vitest";
import {
  exportSessionKey,
  generateSessionKey,
  importSessionKey,
} from "@cadence/protocol";
import { createServer } from "@cadence/relay/server.js";
import { createRoomStore } from "@cadence/relay/rooms.js";
import { CadenceSocket } from "../src/socket.js";

const redisUrl = "redis://127.0.0.1:6379";

function onceEvent(socket: CadenceSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.onEvent((event) => resolve(event));
  });
}

describe("CadenceSocket against the real relay", () => {
  it("sends and receives decrypted wire events and reconnects after drop", async () => {
    const store = createRoomStore(redisUrl);
    const roomId = await store.createRoom();
    store.disconnect();

    const app = createServer({ redisUrl, verifyUser: async () => "cli" });
    await app.listen({ port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const relayUrl = `http://127.0.0.1:${port}`;

    const sessionKey = await generateSessionKey();
    const cli = new CadenceSocket({
      relayUrl,
      roomId,
      token: "t",
      sessionKey,
      sessionId: "sess_cli",
    });
    await cli.connect();

    // A peer (the "phone" role) joins with its own import of the same key.
    const rawKey = await importSessionKey(await exportSessionKey(sessionKey));
    const phone = new CadenceSocket({
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

    // Reconnect: closing the relay kills sockets; CadenceSocket retries
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
});
