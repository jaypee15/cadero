import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { generateSessionKey, encryptEnvelope } from "@cadence/protocol";
import { createServer } from "../src/server.js";
import { createRoomStore } from "../src/rooms.js";

const redisUrl = "redis://127.0.0.1:6379";

function once(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(data.toString()));
    ws.once("error", reject);
  });
}

describe("room routing", () => {
  it("fans an envelope from one member to another and drops malformed frames", async () => {
    const store = createRoomStore(redisUrl);
    const roomId = await store.createRoom();
    store.disconnect();

    const app = createServer({
      redisUrl,
      verifyUser: async () => "test-user",
    });
    await app.listen({ port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const cli = new WebSocket(`ws://127.0.0.1:${port}/v1/stream?room_id=${roomId}&token=t1`);
    const phone = new WebSocket(`ws://127.0.0.1:${port}/v1/stream?room_id=${roomId}&token=t2`);
    await Promise.all([
      new Promise((resolve) => cli.once("open", resolve)),
      new Promise((resolve) => phone.once("open", resolve)),
    ]);

    cli.send("this is not json");
    const key = await generateSessionKey();
    const envelope = await encryptEnvelope(roomId, key, {
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_1" },
      payload: { chunk: "hello phone" },
    });
    const received = once(phone);
    cli.send(JSON.stringify(envelope));
    expect(JSON.parse(await received)).toEqual(envelope);

    let cliEcho: string | null = null;
    cli.once("message", (data) => {
      cliEcho = data.toString();
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(cliEcho).toBeNull();

    cli.close();
    phone.close();
    await app.close();
  }, 15000);

  it("closes the socket with 4403 when redis is unreachable during join", async () => {
    const app = createServer({
      redisUrl: "redis://127.0.0.1:6390",
      verifyUser: async () => "test-user",
    });
    await app.listen({ port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream?room_id=room_x&token=t1`);
    const closed = new Promise<[number, string]>((resolve, reject) => {
      ws.once("close", (code, reason) => resolve([code, reason.toString()]));
      ws.once("error", reject);
    });
    expect(await closed).toEqual([4403, "redis unavailable"]);

    await app.close();
  }, 30000);
});
