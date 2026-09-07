import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

describe("createServer", () => {
  it("answers the health endpoint without Redis running", async () => {
    const app = createServer({ redisUrl: "redis://127.0.0.1:6399" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", redis: "down" });
    await app.close();
  });
});
