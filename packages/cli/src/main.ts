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

/** Spec: agent output stays hidden this long so the QR stays scannable. */
const MIRROR_GRACE_MS = 60000;

const USAGE = `cadero — control local AI agents from your phone

Usage:
  cadero login                          Authenticate with GitHub
  cadero start [options]                Pair a session and start the agent
    --agent <claude|opencode|codex>          Agent binary to spawn (default: claude)
    --relay-url <url>                        Relay base URL (or set CADERO_RELAY_URL)
  cadero --help                         Show this help
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
    if (agent !== "claude" && agent !== "opencode" && agent !== "codex") {
      err(`unknown agent '${agent}' (use claude, opencode, or codex)`);
      return 1;
    }
    if (!relayUrl) {
      err("relay URL required: pass --relay-url or set CADERO_RELAY_URL");
      return 1;
    }
    const creds = await loadCredentials(caderoDir);
    if (!creds) {
      err("not logged in; run: cadero login");
      return 1;
    }

    // Validate the intercept timeout before pairing: an invalid value would
    // otherwise waste a relay connection and a pairing payload before exiting.
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
    // How long the CLI holds agent output back so the pairing QR stays
    // readable (first-run phone pairing includes GitHub sign-in, which can
    // take a while — raise this if you pair slowly).
    const mirrorGraceRaw = env.CADERO_MIRROR_GRACE_MS;
    if (mirrorGraceRaw !== undefined) {
      const parsed = Number(mirrorGraceRaw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        err("CADERO_MIRROR_GRACE_MS must be a positive integer (milliseconds)");
        return 1;
      }
    }
    const mirrorGraceMs =
      mirrorGraceRaw !== undefined ? Number(mirrorGraceRaw) : MIRROR_GRACE_MS;

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
    out(`Scan with your phone (PWA). Relay: ${relayUrl}  Room: ${roomId}`);

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

    // Hold the local mirror until the phone joins (its first resize frame) or
    // a grace period elapses — otherwise the agent's full-screen TUI floods
    // the terminal and destroys the QR the operator still needs to scan.
    let mirroring = false;
    const held: string[] = [];
    // The mirrored stream is a passive viewer: the agent's terminal queries
    // (XTVERSION, DA1, Kitty keyboard, focus-report enables) are housekeeping
    // with no responder attached — the operator's terminal would answer them
    // and the answers echo back as visible garbage.
    const MIRROR_HOUSEKEEPING: RegExp[] = [
      /\x1b\[\?u/g,
      /\x1b\[>0q/g,
      /\x1b\[>q/g,
      /\x1b\[6n/g,
      /\x1b\[c/g,
      /\x1b\[>c/g,
      /\x1b\[\?1004h/g,
      /\x1b\[\?100[0-6]h/g,
      /\x1b\[\?2004h/g,
      /\x1b\[\?[0-9;]*\$p/g,
    ];
    const stripHousekeeping = (chunk: string): string => {
      let out = chunk;
      for (const pattern of MIRROR_HOUSEKEEPING) out = out.replace(pattern, "");
      return out;
    };
    const startMirroring = (reason: string) => {
      if (mirroring) return;
      mirroring = true;
      err(reason);
      for (const chunk of held.splice(0)) process.stdout.write(stripHousekeeping(chunk));
    };
    const graceSeconds = Math.round(mirrorGraceMs / 1000);
    err(
      `waiting for a phone to pair — agent output stays hidden for ${graceSeconds}s, ` +
        `then it appears here (the QR and pairing payload remain in the lines above)`,
    );
    const mirrorGrace = setTimeout(() => {
      startMirroring(
        `no phone paired after ${graceSeconds}s — showing agent output here; ` +
          `pairing still works (the QR and payload remain in the lines above)`,
      );
    }, mirrorGraceMs);

    const session = new AgentSession({
      agent,
      command: agent,
      cwd,
      socket,
      sessionId,
      config,
      interceptTimeoutMs,
      onError: (message) => err(message),
      onLocalOutput: (raw) => {
        const chunk = stripHousekeeping(raw);
        if (chunk.length === 0) return;
        if (mirroring) {
          process.stdout.write(chunk);
        } else {
          held.push(chunk);
          if (held.length > 400) held.shift();
        }
      },
      onPhoneJoined: () => {
        clearTimeout(mirrorGrace);
        startMirroring("phone connected — agent output mirrored here (sized to the phone's viewport)");
      },
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
