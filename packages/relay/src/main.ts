import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { createServer } from "./server.js";

export interface MainOptions {
  env?: NodeJS.ProcessEnv;
}

export interface MainResult {
  app: FastifyInstance;
  port: number;
}

export async function runMain(options: MainOptions = {}): Promise<MainResult> {
  const env = options.env ?? process.env;
  const redisUrl = env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is not set; refusing to start");
  }

  const probe = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1000,
    retryStrategy: () => null,
  });
  probe.on("error", () => {});
  try {
    await probe.connect();
    await probe.ping();
  } catch {
    throw new Error(`redis unreachable at ${redisUrl}; refusing to start`);
  } finally {
    probe.disconnect();
  }

  const app = createServer({ redisUrl });
  const port = Number(env.PORT) || 8787;
  await app.listen({ port, host: "0.0.0.0" });
  const bound = (app.server.address() as AddressInfo).port;
  console.log(`cadence relay listening on :${bound}`);
  return { app, port: bound };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runMain().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
