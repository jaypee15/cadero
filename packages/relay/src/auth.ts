import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import type { RoomStore } from "./rooms.js";
import type { VerifyUser } from "./socket.js";

export type { VerifyUser } from "./socket.js";

export const SESSION_TTL_SECONDS = 43200;
export const OAUTH_STATE_TTL_SECONDS = 600;

function sessionKey(token: string): string {
  return `cadero:session:${token}`;
}

export type VerifyUserWithDisconnect = VerifyUser & { disconnect: () => void };

export function createVerifyUser(
  redisUrl: string,
  fetchImpl?: typeof fetch,
): VerifyUserWithDisconnect {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  redis.on("error", () => {
    // Session lookups fall through to GitHub verification; connection
    // errors surface as a cache miss rather than a failed request.
  });
  const verify = async (token: string): Promise<string> => {
    try {
      const login = await redis.get(sessionKey(token));
      if (login) return login;
    } catch {
      // Redis unavailable: fall back to GitHub verification below.
    }
    return verifyGitHubUser(token, fetchImpl);
  };
  verify.disconnect = () => {
    redis.disconnect();
  };
  return verify;
}

export function sessionTokenKey(token: string): string {
  return sessionKey(token);
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  appUrl: string;
  fetchImpl?: typeof fetch;
}

export async function exchangeOAuthCode(
  config: OAuthConfig,
  code: string,
): Promise<string> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const res = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "cadero-relay",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
    }),
  });
  const body = (await res.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new Error("oauth code exchange failed");
  }
  return body.access_token;
}

interface GitHubUserResponse {
  login?: unknown;
}

export async function verifyGitHubUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cadero-relay",
    },
  });
  if (!res.ok) {
    throw new Error("GitHub auth failed");
  }
  const body = (await res.json()) as GitHubUserResponse;
  if (typeof body.login !== "string" || body.login.length === 0) {
    throw new Error("GitHub auth failed");
  }
  return body.login;
}

export async function pairRoom(
  store: RoomStore,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ room_id: string }> {
  await verifyGitHubUser(accessToken, fetchImpl);
  const room_id = await store.createRoom();
  return { room_id };
}
