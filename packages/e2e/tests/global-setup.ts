// packages/mobile/tests/e2e/global-setup.ts
// Composed-system harness for the full-loop E2E: real Redis, real relay
// process, real CLI process driving a stub `claude`, static server for the
// built mobile export, and a seeded session token.
//
// The CLI gates its raw pairing payload on stdout being a TTY (zero-knowledge
// posture), so the CLI is spawned under a real PTY via node-pty and the
// payload is captured from the PTY stream.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { Redis } from "ioredis";
import { parsePairingPayload } from "@cadence/protocol";
import { runMain } from "@cadence/relay/main.js";

const require = createRequire(import.meta.url);
const pty = require("node-pty") as typeof import("node-pty");

const STATIC_PORT = 4173;
const RELAY_PORT = 8790;
const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`;
const PAYLOAD_PATTERN = /cadence:\/\/pair\?v=1&\S+/;
const SETUP_DEADLINE_MS = 30000;

const here = dirname(fileURLToPath(import.meta.url));
const e2eRoot = join(here, "..");
const repoRoot = join(e2eRoot, "..", "..");
const cliMain = join(repoRoot, "packages", "cli", "dist", "main.js");
const staticRoot = join(repoRoot, "packages", "mobile", "out");

// Tokens and payloads (which embed the session key) must never leak into logs.
function redact(text: string): string {
  return text
    .replace(/key=[A-Za-z0-9_-]+/g, "key=<redacted>")
    .replace(/cadence_[A-Za-z0-9]{32}/g, "cadence_<redacted>");
}

// Async poll with a deadline; must yield to the event loop so the PTY
// stream callbacks can fire.
async function until(fn: () => boolean, purpose: string, log: () => string): Promise<void> {
  const end = Date.now() + SETUP_DEADLINE_MS;
  while (!fn()) {
    if (Date.now() > end) {
      throw new Error(
        `e2e setup timed out after ${SETUP_DEADLINE_MS}ms waiting for ${purpose}.\n--- stream (redacted) ---\n${redact(log())}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const STUB_CLAUDE = `#!/bin/bash
printf "STUB-READY\\n"
while IFS= read -r line; do
  if [[ "$line" == *"danger"* ]]; then
    printf "rm -rf ./dist\\n"
    printf "Do you want to proceed? [y/N]"
    read -r -n 1 answer
    if [[ "$answer" == "y" ]]; then printf "\\nAPPROVED-RESULT\\n"; else printf "\\nDENIED-RESULT\\n"; fi
  else
    printf "ECHO:%s\\n" "$line"
  fi
done
`;

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(cliMain)) {
    throw new Error("packages/cli/dist/main.js missing; build @cadence/cli first");
  }
  if (!existsSync(join(staticRoot, "index.html"))) {
    throw new Error("packages/mobile/out/index.html missing; build @cadence/mobile first");
  }

  const token = `cadence_${randomBytes(16).toString("hex")}`;
  const tempBase = mkdtempSync(join(tmpdir(), "cadence-e2e-"));
  const homeDir = join(tempBase, "home");
  const projectDir = join(tempBase, "project");
  const stubDir = join(tempBase, "bin");
  mkdirSync(join(homeDir, ".cadence"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(join(homeDir, ".cadence", "credentials.json"), JSON.stringify({ githubToken: token }));
  writeFileSync(join(stubDir, "claude"), STUB_CLAUDE, { mode: 0o755 });

  const redis = new Redis("redis://127.0.0.1:6379", { maxRetriesPerRequest: 3 });
  const staticServer = spawn(
    process.execPath,
    [join(here, "static-server.mjs"), staticRoot, String(STATIC_PORT)],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const staticLog: string[] = [];
  staticServer.stdout?.on("data", (chunk: Buffer) => staticLog.push(chunk.toString()));
  staticServer.stderr?.on("data", (chunk: Buffer) => staticLog.push(chunk.toString()));

  let app: Awaited<ReturnType<typeof runMain>>["app"] | undefined;
  let cliPty: import("node-pty").IPty | undefined;
  const cliLogBuffer: string[] = [];

  const teardown = async (): Promise<void> => {
    cliPty?.kill();
    if (process.env.CADENCE_E2E_DEBUG) {
      console.log(`--- CLI PTY stream (redacted) ---\n${redact(cliLogBuffer.join(""))}`);
    }
    try {
      await app?.close();
    } catch {
      /* already closed */
    }
    staticServer.kill("SIGTERM");
    try {
      await redis.del(`cadence:session:${token}`);
    } catch {
      /* best effort */
    }
    redis.disconnect();
    rmSync(tempBase, { recursive: true, force: true });
  };

  try {
    app = (await runMain({ env: { REDIS_URL: "redis://127.0.0.1:6379", PORT: String(RELAY_PORT) } })).app;

    await redis.set(`cadence:session:${token}`, "e2e-user", "EX", 3600);

    await new Promise<void>((resolve, reject) => {
      const end = Date.now() + SETUP_DEADLINE_MS;
      const poll = setInterval(() => {
        if (staticLog.some((l) => l.includes(`static on ${STATIC_PORT}`))) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() > end) {
          clearInterval(poll);
          reject(new Error(`static server did not start: ${staticLog.join("")}`));
        }
      }, 50);
    });

    cliPty = pty.spawn(process.execPath, [cliMain, "start", "--agent", "claude", "--relay-url", RELAY_URL], {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd: projectDir,
      env: {
        ...process.env,
        HOME: homeDir,
        PATH: `${stubDir}:${process.env.PATH ?? ""}`,
        CADENCE_GITHUB_CLIENT_ID: "unused",
      } as { [key: string]: string },
    });
    let payload: string | undefined;
    let cliExit: string | undefined;
    cliPty.onData((chunk) => {
      cliLogBuffer.push(chunk);
      if (!payload) {
        const hit = cliLogBuffer.join("").match(PAYLOAD_PATTERN);
        if (hit) payload = hit[0];
      }
    });
    cliPty.onExit(({ exitCode }) => {
      cliExit = `CLI exited (code ${exitCode}) during setup`;
    });

    await until(
      () => {
        if (cliExit !== undefined) {
          throw new Error(
            `${cliExit} before pairing payload.\n--- stream (redacted) ---\n${redact(cliLogBuffer.join(""))}`,
          );
        }
        return payload !== undefined;
      },
      "the pairing payload",
      () => cliLogBuffer.join(""),
    );

    try {
      parsePairingPayload(payload as string);
    } catch (err) {
      const value = payload as string;
      throw new Error(
        `captured pairing payload does not parse (${err instanceof Error ? err.message : String(err)}); ` +
          `payload length ${value.length}, starts with ${JSON.stringify(value.slice(0, 14))}`,
      );
    }
    await until(
      () => {
        if (cliExit !== undefined) {
          throw new Error(
            `${cliExit} before agent session start.\n--- stream (redacted) ---\n${redact(cliLogBuffer.join(""))}`,
          );
        }
        return /agent 'claude' running/.test(cliLogBuffer.join(""));
      },
      "the agent session start",
      () => cliLogBuffer.join(""),
    );

    if (process.env.CADENCE_E2E_DEBUG) {
      console.log(`--- CLI PTY stream (redacted) ---\n${redact(cliLogBuffer.join(""))}`);
    }

    process.env.CADENCE_E2E_TOKEN = token;
    process.env.CADENCE_E2E_PAYLOAD = payload as string;

    return teardown;
  } catch (err) {
    await teardown();
    throw err;
  }
}
