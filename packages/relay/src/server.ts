import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import {
  createVerifyUser,
  exchangeOAuthCode,
  OAUTH_STATE_TTL_SECONDS,
  SESSION_TTL_SECONDS,
  verifyGitHubUser,
  type OAuthConfig,
} from "./auth.js";
import { createRoomStore } from "./rooms.js";
import { registerStreamRoute } from "./socket.js";
import type { VerifyUser } from "./socket.js";

export interface ServerOptions {
  redisUrl: string;
  verifyUser?: VerifyUser;
  oauth?: OAuthConfig;
}

export function createServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const redis = new Redis(options.redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  redis.on("error", () => {
    // Health endpoint reports status; connection errors stay silent here
    // so unauthenticated callers learn nothing beyond up or down.
  });

  const defaultVerify = options.verifyUser ? null : createVerifyUser(options.redisUrl);
  const verifyUser = options.verifyUser ?? defaultVerify!;

  void app.register(async (app) => {
    await app.register(websocket);
    registerStreamRoute(app, options.redisUrl, verifyUser);
  });

  app.get("/health", async () => {
    try {
      await redis.ping();
      return { status: "ok", redis: "up" as const };
    } catch {
      return { status: "ok", redis: "down" as const };
    }
  });

  app.post("/v1/pair", async (request, reply) => {
    const auth = request.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    try {
      await verifyUser(token);
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
    let room_id: string;
    try {
      const store = createRoomStore(options.redisUrl);
      try {
        room_id = await store.createRoom();
      } finally {
        store.disconnect();
      }
    } catch {
      return reply.code(503).send({ error: "relay unavailable" });
    }
    return { room_id };
  });

  const oauthRedis = new Redis(options.redisUrl, { maxRetriesPerRequest: 3 });
  oauthRedis.on("error", () => {
    // OAuth state writes/reads fail closed via route handlers; connection
    // errors stay silent here.
  });

  app.get("/v1/oauth/login", async (_request, reply) => {
    if (!options.oauth) {
      return reply.code(503).send({ error: "oauth not configured" });
    }
    const state = randomBytes(16).toString("hex");
    try {
      await oauthRedis.set(`cadence:oauth:state:${state}`, "1", "EX", OAUTH_STATE_TTL_SECONDS);
    } catch {
      return reply.code(503).send({ error: "relay unavailable" });
    }
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", options.oauth.clientId);
    authorize.searchParams.set("redirect_uri", `${options.oauth.publicUrl}/v1/oauth/callback`);
    authorize.searchParams.set("scope", "read:user");
    authorize.searchParams.set("state", state);
    return reply.redirect(authorize.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string } }>(
    "/v1/oauth/callback",
    async (request, reply) => {
      if (!options.oauth) {
        return reply.code(503).send({ error: "oauth not configured" });
      }
      const { code, state } = request.query;
      if (!code || !state) {
        return reply.code(400).send({ error: "invalid state" });
      }
      let deleted: number;
      try {
        deleted = await oauthRedis.del(`cadence:oauth:state:${state}`);
      } catch {
        return reply.code(503).send({ error: "relay unavailable" });
      }
      if (deleted !== 1) {
        return reply.code(400).send({ error: "invalid state" });
      }
      try {
        const githubToken = await exchangeOAuthCode(options.oauth, code);
        const login = await verifyGitHubUser(githubToken, options.oauth.fetchImpl);
        const token = `cadence_${randomBytes(16).toString("hex")}`;
        await oauthRedis.set(`cadence:session:${token}`, login, "EX", SESSION_TTL_SECONDS);
        const target = new URL(options.oauth.appUrl);
        target.hash = `token=${token}`;
        return reply.redirect(target.toString());
      } catch {
        return reply.code(401).send({ error: "oauth exchange failed" });
      }
    },
  );

  app.addHook("onClose", async () => {
    redis.disconnect();
    oauthRedis.disconnect();
    if (defaultVerify) defaultVerify.disconnect();
  });

  return app;
}
