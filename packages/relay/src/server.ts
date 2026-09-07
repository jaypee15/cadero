import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { Redis } from "ioredis";
import { verifyGitHubUser } from "./auth.js";
import { createRoomStore } from "./rooms.js";
import { registerStreamRoute } from "./socket.js";
import type { VerifyUser } from "./socket.js";

export interface ServerOptions {
  redisUrl: string;
  verifyUser?: VerifyUser;
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

  void app.register(async (app) => {
    await app.register(websocket);
    registerStreamRoute(
      app,
      options.redisUrl,
      options.verifyUser ?? verifyGitHubUser,
    );
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
      await (options.verifyUser ?? verifyGitHubUser)(token);
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const store = createRoomStore(options.redisUrl);
    try {
      const room_id = await store.createRoom();
      return { room_id };
    } finally {
      store.disconnect();
    }
  });

  app.addHook("onClose", async () => {
    redis.disconnect();
  });

  return app;
}
