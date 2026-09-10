import { afterAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { createRoomStore } from "../src/rooms.js";

const redisUrl = "redis://127.0.0.1:6379";

describe("createRoomStore", () => {
  const admin = new Redis(redisUrl);
  afterAll(() => admin.disconnect());

  it("creates rooms that exist with a 4-hour TTL", async () => {
    const store = createRoomStore(redisUrl);
    const roomId = await store.createRoom();
    expect(roomId).toMatch(/^room_[0-9a-f]{16}$/);
    expect(await store.roomExists(roomId)).toBe(true);
    const ttl = await admin.ttl(`cadero:room:${roomId}`);
    expect(ttl).toBeGreaterThan(14000);
    expect(ttl).toBeLessThanOrEqual(14400);
    store.disconnect();
  });

  it("reports unknown rooms as missing", async () => {
    const store = createRoomStore(redisUrl);
    expect(await store.roomExists("room_0000000000000000")).toBe(false);
    store.disconnect();
  });
});
