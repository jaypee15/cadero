#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCredentials, saveCredentials, CADERO_DIR_DEFAULT } from "./credentials.js";
import { pollForAccessToken, requestDeviceCode } from "./ghDevice.js";
import { pairSession } from "./pairing.js";
import { CaderoSocket } from "./socket.js";
import { AgentSession, INTERCEPT_TIMEOUT_MS } from "./session.js";
import { loadConfig } from "./config.js";
import type { AgentName } from "./intercept.js";

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  caderoDir?: string;
  cwd?: string;
  fetchImpl?: typeof fetch;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Override for the process.stdout.isTTY check (tests). */
  isTTY?: boolean;
}

const USAGE = `cadero-cli — control local AI agents from your phone

Usage:
  cadero-cli login                          Authenticate with GitHub
  cadero-cli start [options]                Pair a session and start the agent
    --agent <claude|opencode>                Agent binary to spawn (default: claude)
    --relay-url <url>                        Relay base URL (or set CADERO_RELAY_URL)
  cadero-cli --help                         Show this help
`;

export async function runCli(argv: string[], opts: RunOptions = {}): Promise<number> {
  const out = opts.stdout ?? ((line: string) => console.log(line));
  const err = opts.stderr ?? ((line: string) => console.error(line));
  const env = opts.env ?? process.env;
  const caderoDir = opts.caderoDir ?? CADERO_DIR_DEFAULT;
  const cwd = opts.cwd ?? process.cwd();
  const fetchImpl = opts.fetchImpl ?? fetch;

  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === undefined) {
    out(USAGE);
    return 0;
  }

  if (command === "login") {
    const clientId = env.CADERO_GITHUB_CLIENT_ID;
    if (!clientId) {
      err("CADERO_GITHUB_CLIENT_ID is not set; register a GitHub OAuth app and set it to enable login");
      return 1;
    }
    const device = await requestDeviceCode(fetchImpl, clientId);
    out(`Open ${device.verification_uri} and enter code: ${device.user_code}`);
    const token = await pollForAccessToken(
      fetchImpl,
      device.device_code,
      {
        interval: device.interval,
        expiresIn: device.expiresIn,
      },
      clientId,
    );
    await saveCredentials(caderoDir, { githubToken: token });
    out(`logged in; credentials saved to ${caderoDir}/credentials.json`);
    return 0;
  }

  if (command === "start") {
    let agent: AgentName = "claude";
    let relayUrl = env.CADERO_RELAY_URL ?? "";
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === "--agent") {
        agent = rest[i + 1] as AgentName;
        i += 1;
      } else if (rest[i] === "--relay-url") {
        relayUrl = rest[i + 1] ?? "";
        i += 1;
      }
    }
    if (agent !== "claude" && agent !== "opencode") {
      err(`unknown agent '${agent}' (use claude or opencode)`);
      return 1;
    }
    if (!relayUrl) {
      err("relay URL required: pass --relay-url or set CADERO_RELAY_URL");
      return 1;
    }
    const creds = await loadCredentials(caderoDir);
    if (!creds) {
      err("not logged in; run: cadero-cli login");
      return 1;
    }

    const { roomId, sessionKey, qrPayload } = await pairSession(
      relayUrl,
      creds.githubToken,
      fetchImpl,
    );
    const qr = await import("qrcode");
    out(
      await qr.toString(qrPayload, {
        type: "terminal",
        small: true,
        errorCorrectionLevel: "low",
      }),
    );
    // Zero-knowledge: the raw session key stays on the visible terminal
    // (manual fallback for a failed scan). Never expose it to redirects,
    // so only print it when stdout is an interactive TTY.
    if (opts.isTTY ?? process.stdout.isTTY) {
      out(qrPayload);
    }
    out(`Scan with your phone. Relay: ${relayUrl}  Room: ${roomId}`);

    const sessionId = `sess_${randomBytes(8).toString("hex")}`;
    const socket = new CaderoSocket({
      relayUrl,
      roomId,
      token: creds.githubToken,
      sessionKey,
      sessionId,
      onClose: (code, reason) => {
        err(`relay closed the session (${code} ${reason}); exiting`);
        process.exit(1);
      },
      onFatal: () => {
        err(
          "session key rejected by peer (decryption_failed); pairing mismatch — rescan the QR",
        );
        process.exit(1);
      },
    });
    await socket.connect();

    const config = await loadConfig(cwd);
    const interceptTimeoutRaw = env.CADERO_INTERCEPT_TIMEOUT_MS;
    if (interceptTimeoutRaw !== undefined) {
      const parsed = Number(interceptTimeoutRaw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        err("CADERO_INTERCEPT_TIMEOUT_MS must be a positive integer (milliseconds)");
        return 1;
      }
    }
    const interceptTimeoutMs =
      interceptTimeoutRaw !== undefined ? Number(interceptTimeoutRaw) : INTERCEPT_TIMEOUT_MS;
    const session = new AgentSession({
      agent,
      command: agent,
      cwd,
      socket,
      sessionId,
      config,
      interceptTimeoutMs,
      onError: (message) => err(message),
      onLocalOutput: (chunk) => process.stdout.write(chunk),
      onEnd: (code) => {
        err(`agent exited with code ${code}; session closed`);
        process.exit(code === 0 ? 0 : 1);
      },
    });
    session.start();
    out(`agent '${agent}' running in ${cwd} (session ${sessionId})`);

    const shutdown = async () => {
      session.stop();
      await socket.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    return 0; // start keeps the process alive via the PTY + socket handles
  }

  err(USAGE);
  return 1;
}

function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // npm bin symlinks: Node realpaths the module, so argv[1] must be
    // real pathed too before the comparison.
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    // argv[1] disappeared or is unresolvable: fall back to the URL comparison
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectInvocation()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
