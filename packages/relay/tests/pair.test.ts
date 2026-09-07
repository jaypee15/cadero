import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { createRoomStore } from "../src/rooms.js";

const redisUrl = "redis://127.0.0.1:6379";

describe("POST /v1/pair", () => {
  it("pairs an authenticated token to a fresh room", async () => {
    const app = createServer({ redisUrl, verifyUser: async () => "octocat" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/pair",
      headers: { authorization: "Bearer good" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { room_id: string };
    expect(body.room_id).toMatch(/^room_[0-9a-f]{16}$/);
    const store = createRoomStore(redisUrl);
    expect(await store.roomExists(body.room_id)).toBe(true);
    store.disconnect();
    await app.close();
  });

  it("rejects an unauthenticated token with 401", async () => {
    const app = createServer({
      redisUrl,
      verifyUser: async () => {
        throw new Error("GitHub auth failed");
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/pair",
      headers: { authorization: "Bearer bad" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
    await app.close();
  });
});
