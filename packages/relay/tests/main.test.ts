import { describe, expect, it } from "vitest";
import { runMain } from "../src/main.js";

const redisUrl = "redis://127.0.0.1:6379";

describe("main entrypoint", () => {
  it("rejects with a clear error when REDIS_URL is unset", async () => {
    await expect(runMain({ env: {} })).rejects.toThrow(/REDIS_URL/);
  });

  it("rejects when redis is unreachable", async () => {
    await expect(
      runMain({ env: { REDIS_URL: "redis://127.0.0.1:6390" } }),
    ).rejects.toThrow(/unreachable/i);
  }, 15000);

  it("listens and returns the bound port", async () => {
    const { app, port } = await runMain({ env: { REDIS_URL: redisUrl, PORT: "0" } });
    expect(port).toBeGreaterThan(0);
    await app.close();
  });
});

describe("oauth env wiring", () => {
  it("fails loudly on a partial oauth env", async () => {
    await expect(
      runMain({
        env: {
          REDIS_URL: redisUrl,
          GITHUB_OAUTH_CLIENT_ID: "cid",
        },
      }),
    ).rejects.toThrow("oauth env incomplete");
  });

  it("wires the portal when the full quartet is set", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
    const { app } = await runMain({
      env: {
        REDIS_URL: redisUrl,
        PORT: "0",
        GITHUB_OAUTH_CLIENT_ID: "cid",
        GITHUB_OAUTH_CLIENT_SECRET: "sec",
        CADERO_RELAY_PUBLIC_URL: "https://relay.example.com",
        CADERO_APP_URL: "https://app.example.com",
      },
      fetchImpl,
    });
    const res = await app.inject({ method: "GET", url: "/v1/oauth/login" });
    expect(res.statusCode).toBe(302);
    await app.close();
  });
});
