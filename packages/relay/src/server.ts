import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { Redis } from "ioredis";

export interface ServerOptions {
  redisUrl: string;
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

  void app.register(websocket);

  app.get("/health", async () => {
    try {
      await redis.ping();
      return { status: "ok", redis: "up" as const };
    } catch {
      return { status: "ok", redis: "down" as const };
    }
  });

  app.addHook("onClose", async () => {
    redis.disconnect();
  });

  return app;
}
