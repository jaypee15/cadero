import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { generateSessionKey, encryptEnvelope } from "@cadero/protocol";
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
    const envelope = await encryptEnvelope(
      roomId,
      key,
      {
        event: "TERMINAL_DATA",
        meta: { session_id: "sess_1" },
        payload: { chunk: "hello phone" },
      },
      { sender: "cli", seq: 0 },
    );
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

  it("drops an envelope addressed to a different room (routing integrity)", async () => {
    const store = createRoomStore(redisUrl);
    const roomId = await store.createRoom();
    const otherRoom = await store.createRoom();
    store.disconnect();

    const app = createServer({ redisUrl, verifyUser: async () => "test-user" });
    await app.listen({ port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const sender = new WebSocket(`ws://127.0.0.1:${port}/v1/stream?room_id=${roomId}&token=t1`);
    const phone = new WebSocket(`ws://127.0.0.1:${port}/v1/stream?room_id=${roomId}&token=t2`);
    await Promise.all([
      new Promise((resolve) => sender.once("open", resolve)),
      new Promise((resolve) => phone.once("open", resolve)),
    ]);
    const key = await generateSessionKey();

    // Schema-valid, stamped, but addressed to the OTHER room: the relay must
    // drop it rather than fan it out to room roomId.
    const misaddressed = await encryptEnvelope(
      otherRoom,
      key,
      {
        event: "TERMINAL_DATA",
        meta: { session_id: "sess_1" },
        payload: { chunk: "cross-room leak" },
      },
      { sender: "cli", seq: 0 },
    );
    const received: string[] = [];
    phone.on("message", (data) => received.push(data.toString()));
    sender.send(JSON.stringify(misaddressed));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(received).toHaveLength(0);

    // Sanity: a correctly-addressed frame still gets through on the same
    // socket (new seq).
    const onTarget = await encryptEnvelope(
      roomId,
      key,
      {
        event: "TERMINAL_DATA",
        meta: { session_id: "sess_1" },
        payload: { chunk: "in room" },
      },
      { sender: "cli", seq: 1 },
    );
    const got = new Promise<string>((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const poll = () => {
        if (received.length > 0) return resolve(received[0]);
        if (Date.now() > deadline) return reject(new Error("no frame received"));
        setTimeout(poll, 50);
      };
      poll();
    });
    sender.send(JSON.stringify(onTarget));
    expect(JSON.parse(await got)).toMatchObject({ room_id: roomId });

    sender.close();
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

describe("replay protection", () => {
  it("requires a monotonic per-sender seq header and drops regressions", async () => {
    const store = createRoomStore(redisUrl);
    const roomId = await store.createRoom();
    store.disconnect();

    const app = createServer({ redisUrl, verifyUser: async () => "test-user" });
    await app.listen({ port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const cli = new WebSocket(`ws://127.0.0.1:${port}/v1/stream?room_id=${roomId}&token=t1`);
    const phone = new WebSocket(`ws://127.0.0.1:${port}/v1/stream?room_id=${roomId}&token=t2`);
    await Promise.all([
      new Promise((resolve) => cli.once("open", resolve)),
      new Promise((resolve) => phone.once("open", resolve)),
    ]);
    const key = await generateSessionKey();

    const stamped = async (seq: number, sender: string) =>
      JSON.stringify({
        ...(await encryptEnvelope(roomId, key, {
          event: "TERMINAL_DATA",
          meta: { session_id: "sess_1" },
          payload: { chunk: `chunk-${seq}` },
        })),
        sender,
        seq,
      });

    // Unstamped frames are dropped outright.
    const unstamped = await encryptEnvelope(roomId, key, {
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_1" },
      payload: { chunk: "unstamped" },
    });
    cli.send(JSON.stringify(unstamped));

    // seq 5 arrives.
    const got5 = once(phone);
    cli.send(await stamped(5, "sender-a"));
    expect(JSON.parse(await got5)).toMatchObject({ seq: 5 });

    // Replay of seq 5 and regression to 4 are both dropped.
    cli.send(await stamped(5, "sender-a"));
    cli.send(await stamped(4, "sender-a"));
    await new Promise((resolve) => setTimeout(resolve, 400));

    // A new seq advances and is delivered again.
    const got6 = once(phone);
    cli.send(await stamped(6, "sender-a"));
    expect(JSON.parse(await got6)).toMatchObject({ seq: 6 });

    // A different sender is tracked independently.
    const gotB = once(phone);
    cli.send(await stamped(0, "sender-b"));
    expect(JSON.parse(await gotB)).toMatchObject({ sender: "sender-b" });

    cli.close();
    phone.close();
    await app.close();
  }, 15000);
});

describe("close-code contract", () => {
  // Connect-refused races could otherwise hang until the suite timeout:
  // every close promise carries an error handler and an explicit deadline.
  const CLOSE_DEADLINE_MS = 10000;

  function expectClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("socket never closed (deadline)")),
        CLOSE_DEADLINE_MS,
      );
      ws.on("error", (err) => {
        clearTimeout(deadline);
        reject(err);
      });
      ws.on("close", (code, reason) => {
        clearTimeout(deadline);
        resolve({ code, reason: reason.toString() });
      });
    });
  }

  it("closes with 4401 when verifyUser rejects", async () => {
    const app = createServer({
      redisUrl,
      verifyUser: async () => {
        throw new Error("GitHub auth failed");
      },
    });
    await app.listen({ port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream?room_id=room_x&token=t`);
    const result = await expectClose(ws);
    expect(result.code).toBe(4401);
    await app.close();
  });

  it("closes with 4404 for an unknown room", async () => {
    const app = createServer({ redisUrl, verifyUser: async () => "octocat" });
    await app.listen({ port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/v1/stream?room_id=room_0000000000000000&token=t`,
    );
    const result = await expectClose(ws);
    expect(result.code).toBe(4404);
    await app.close();
  });
});
