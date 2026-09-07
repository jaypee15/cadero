import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

const deadRedis = "redis://127.0.0.1:6399"; // nothing listens here

describe("shaped failures when redis is unreachable", () => {
  it("pair returns 503 with a shaped body", async () => {
    const app = createServer({ redisUrl: deadRedis, verifyUser: async () => "octocat" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/pair",
      headers: { authorization: "Bearer t" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "relay unavailable" });
    await app.close();
  });

  it("oauth login returns 503 when the state cannot be stored", async () => {
    const app = createServer({
      redisUrl: deadRedis,
      oauth: {
        clientId: "cid",
        clientSecret: "sec",
        publicUrl: "https://relay.example.com",
        appUrl: "https://app.example.com",
      },
    });
    const res = await app.inject({ method: "GET", url: "/v1/oauth/login" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "relay unavailable" });
    await app.close();
  });
});
