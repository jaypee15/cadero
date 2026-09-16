// packages/relay/tests/oauthCallback.test.ts
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

const oauth = {
  clientId: "cid",
  clientSecret: "sec",
  publicUrl: "https://relay.example.com",
  appUrl: "https://app.example.com",
  // Both GitHub calls succeed so the flow reaches the session-store step.
  fetchImpl: (async (url: RequestInfo | URL) => {
    const target = String(url);
    const body = target.includes("api.github.com")
      ? { login: "octocat" }
      : { access_token: "gho_test" };
    return {
      ok: true,
      json: async () => body,
    } as unknown as Response;
  }) as typeof fetch,
};

async function injectCallback(app: Awaited<ReturnType<typeof createServer>>) {
  return app.inject({
    method: "GET",
    url: "/v1/oauth/callback?code=ghcode&state=st",
  });
}

describe("oauth callback", () => {
  it("redirects with the session token when the store succeeds", async () => {
    const app = createServer({
      redisUrl: "redis://127.0.0.1:6399",
      oauth,
      oauthStore: {
        del: async () => 1,
        set: async () => "OK",
      },
    });
    const res = await injectCallback(app);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("app.example.com");
    expect(res.headers.location).toMatch(/#token=cadero_/);
    await app.close();
  });

  it("maps a session-store failure to 503, not 401 (state was already consumed)", async () => {
    const app = createServer({
      redisUrl: "redis://127.0.0.1:6399",
      oauth,
      oauthStore: {
        del: async () => 1,
        set: async () => {
          throw new Error("redis blip");
        },
      },
    });
    const res = await injectCallback(app);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "relay unavailable" });
    await app.close();
  });

  it("keeps 401 for a GitHub exchange failure (auth, not availability)", async () => {
    const app = createServer({
      redisUrl: "redis://127.0.0.1:6399",
      oauth: {
        ...oauth,
        fetchImpl: (async () => {
          throw new Error("github down");
        }) as typeof fetch,
      },
      oauthStore: {
        del: async () => 1,
        set: async () => "OK",
      },
    });
    const res = await injectCallback(app);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "oauth exchange failed" });
    await app.close();
  });
});
