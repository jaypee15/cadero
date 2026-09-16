// packages/cli/tests/staleness-soak.test.ts
// Soak test for half-open TCP detection against a SUSPENDED relay: the 45s
// force-reconnect exists because a silently-frozen peer must eventually be
// abandoned (compose topology: nginx's 1h proxy_read_timeout would otherwise
// keep the half-open socket alive indefinitely). The relay runs as a CHILD
// process so it can be SIGSTOP'd mid-session — suspending the test process
// itself would freeze the test. Skipped unless RUN_SOAK=1 (~90s).
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import { generateSessionKey } from "@cadero/protocol";
import { createRoomStore } from "@cadero/relay/rooms.js";
import { CaderoSocket, STALE_AFTER_MS } from "../src/socket.js";

const redisUrl = "redis://127.0.0.1:6379";
const RELAY_PORT = 8791;
// The child relay verifies tokens against the Redis session store (no test
// injection), so the sockets must carry a real seeded token.
const token = `cadero_${randomBytes(16).toString("hex")}`;

const here = dirname(fileURLToPath(import.meta.url));
const relayMain = join(here, "..", "..", "relay", "dist", "main.js");

// Sets a one-shot chunk listener on the CLI socket; resolves when a frame
// containing `text` arrives (or "timeout" past the deadline).
function onceChunk(socket: CaderoSocket, text: string, timeoutMs: number): Promise<"ok" | "timeout"> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve("timeout");
      }
    }, timeoutMs);
    socket.onEvent((event) => {
      if (done) return;
      const chunk = String((event.payload as { chunk?: string }).chunk ?? "");
      if (chunk.includes(text)) {
        done = true;
        clearTimeout(timer);
        resolve("ok");
      }
    });
  });
}

describe("staleness soak", () => {
  it.skipIf(process.env.RUN_SOAK !== "1")(
    "recovers from a suspended relay via the force-reconnect path",
    async () => {
      const rooms = createRoomStore(redisUrl);
      const roomId = await rooms.createRoom();
      rooms.disconnect();

      const seed = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
      await seed.set(`cadero:session:${token}`, "soak-user", "EX", 3600);
      seed.disconnect();

      const relay: ChildProcess = spawn(process.execPath, [relayMain], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, REDIS_URL: redisUrl, PORT: String(RELAY_PORT) },
      });
      try {
        const deadline = Date.now() + 15000;
        let up = false;
        relay.stdout?.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes(`listening on :${RELAY_PORT}`)) up = true;
        });
        while (!up && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(up).toBe(true);
        const relayUrl = `http://127.0.0.1:${RELAY_PORT}`;

        const key = await generateSessionKey();
        const phone = new CaderoSocket({
          relayUrl,
          roomId,
          token,
          sessionKey: key,
          sessionId: "sess_phone",
        });
        const peer = new CaderoSocket({
          relayUrl,
          roomId,
          token,
          sessionKey: key,
          sessionId: "sess_peer",
        });
        await phone.connect();
        await peer.connect();

        // Pre-suspend sanity: register the listener, then send.
        const sawBefore = onceChunk(phone, "before", 10000);
        await peer.send({
          event: "TERMINAL_DATA",
          meta: { session_id: "sess_peer" },
          payload: { chunk: "before" },
        });
        expect(await sawBefore).toBe("ok");

        // Suspend: TCP goes half-open (the kernel still accepts connections,
        // but the process never reads or writes). The staleness timer must
        // force the reconnect path; after the resume, frames must flow again
        // without any manual intervention.
        relay.kill("SIGSTOP");
        await new Promise((r) => setTimeout(r, STALE_AFTER_MS + 20000));
        relay.kill("SIGCONT");

        // Give the resumed relay a moment, then prove recovery end to end.
        await new Promise((r) => setTimeout(r, 2000));
        const sawResumed = onceChunk(phone, "resumed", 30000);
        await peer.send({
          event: "TERMINAL_DATA",
          meta: { session_id: "sess_peer" },
          payload: { chunk: "resumed" },
        });
        expect(await sawResumed).toBe("ok");

        await phone.close();
        await peer.close();
      } finally {
        relay.kill("SIGKILL");
      }
    },
    240000,
  );

  it("documents the staleness contract", () => {
    expect(STALE_AFTER_MS).toBe(45000);
  });
});
