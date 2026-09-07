import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { createVerifyUser, SESSION_TTL_SECONDS } from "../src/auth.js";

const redisUrl = "redis://127.0.0.1:6379";

const OAUTH_ENV = {
  clientId: "cid123",
  clientSecret: "secret456",
  publicUrl: "https://relay.example.com",
  appUrl: "https://app.example.com",
};

function fakeGithubFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(String(init?.body)) as { code: string };
      if (body.code !== "good-code") {
        return new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 200 });
      }
      return new Response(JSON.stringify({ access_token: "gh-token-1" }), { status: 200 });
    }
    if (url === "https://api.github.com/user") {
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth === "Bearer gh-token-1") {
        return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
      }
      return new Response("{}", { status: 401 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

describe("OAuth portal", () => {
  it("login redirects to GitHub authorize with a stored state", async () => {
    const app = createServer({ redisUrl, oauth: { ...OAUTH_ENV, fetchImpl: fakeGithubFetch() } });
    const res = await app.inject({ method: "GET", url: "/v1/oauth/login" });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.host).toBe("github.com");
    expect(location.searchParams.get("client_id")).toBe("cid123");
    expect(location.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
    await app.close();
  });

  it("callback mints a session token and redirects to the app", async () => {
    const app = createServer({ redisUrl, oauth: { ...OAUTH_ENV, fetchImpl: fakeGithubFetch() } });
    const login = await app.inject({ method: "GET", url: "/v1/oauth/login" });
    const state = new URL(login.headers.location as string).searchParams.get("state") as string;

    const res = await app.inject({
      method: "GET",
      url: `/v1/oauth/callback?code=good-code&state=${state}`,
    });
    expect(res.statusCode).toBe(302);
    const target = new URL(res.headers.location as string);
    expect(target.origin + target.pathname).toBe("https://app.example.com/");
    const token = target.hash.replace("#token=", "");
    expect(token).toMatch(/^cadence_[0-9a-f]{32}$/);

    // The session token authenticates the stream handshake like a PAT would.
    const verify = createVerifyUser(redisUrl, fakeGithubFetch());
    expect(await verify(token)).toBe("octocat");
    await app.close();
  });

  it("rejects an unknown state with 400", async () => {
    const app = createServer({ redisUrl, oauth: { ...OAUTH_ENV, fetchImpl: fakeGithubFetch() } });
    const res = await app.inject({
      method: "GET",
      url: "/v1/oauth/callback?code=good-code&state=00000000000000000000000000000000",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid state" });
    await app.close();
  });

  it("session tokens honor the 12h TTL", async () => {
    expect(SESSION_TTL_SECONDS).toBe(43200);
  });

  it("returns 503 when oauth is not configured", async () => {
    const app = createServer({ redisUrl });
    const res = await app.inject({ method: "GET", url: "/v1/oauth/login" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});
