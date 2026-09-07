import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadCredentials, saveCredentials, CADENCE_DIR_DEFAULT } from "./credentials.js";
import { pollForAccessToken, requestDeviceCode } from "./ghDevice.js";
import { pairSession } from "./pairing.js";
import { CadenceSocket } from "./socket.js";
import { AgentSession } from "./session.js";
import { loadConfig } from "./config.js";
import type { AgentName } from "./intercept.js";

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cadenceDir?: string;
  cwd?: string;
  fetchImpl?: typeof fetch;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const USAGE = `cadence-cli — control local AI agents from your phone

Usage:
  cadence-cli login                          Authenticate with GitHub
  cadence-cli start [options]                Pair a session and start the agent
    --agent <claude|opencode>                Agent binary to spawn (default: claude)
    --relay-url <url>                        Relay base URL (or set CADENCE_RELAY_URL)
  cadence-cli --help                         Show this help
`;

export async function runCli(argv: string[], opts: RunOptions = {}): Promise<number> {
  const out = opts.stdout ?? ((line: string) => console.log(line));
  const err = opts.stderr ?? ((line: string) => console.error(line));
  const env = opts.env ?? process.env;
  const cadenceDir = opts.cadenceDir ?? CADENCE_DIR_DEFAULT;
  const cwd = opts.cwd ?? process.cwd();
  const fetchImpl = opts.fetchImpl ?? fetch;

  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === undefined) {
    out(USAGE);
    return 0;
  }

  if (command === "login") {
    const device = await requestDeviceCode(fetchImpl);
    out(`Open ${device.verification_uri} and enter code: ${device.user_code}`);
    const token = await pollForAccessToken(fetchImpl, device.device_code, {
      interval: device.interval,
      expiresIn: device.expiresIn,
    });
    await saveCredentials(cadenceDir, { githubToken: token });
    out(`logged in; credentials saved to ${cadenceDir}/credentials.json`);
    return 0;
  }

  if (command === "start") {
    let agent: AgentName = "claude";
    let relayUrl = env.CADENCE_RELAY_URL ?? "";
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
      err("relay URL required: pass --relay-url or set CADENCE_RELAY_URL");
      return 1;
    }
    const creds = await loadCredentials(cadenceDir);
    if (!creds) {
      err("not logged in; run: cadence-cli login");
      return 1;
    }

    const { roomId, sessionKey, qrPayload } = await pairSession(
      relayUrl,
      creds.githubToken,
      fetchImpl,
    );
    const qr = await import("qrcode");
    out(await qr.toString(qrPayload, { type: "terminal" }));
    out(`Scan with your phone. Relay: ${relayUrl}  Room: ${roomId}`);

    const sessionId = `sess_${randomBytes(8).toString("hex")}`;
    const socket = new CadenceSocket({
      relayUrl,
      roomId,
      token: creds.githubToken,
      sessionKey,
      sessionId,
      onClose: (code, reason) => {
        err(`relay closed the session (${code} ${reason}); exiting`);
        process.exit(1);
      },
    });
    await socket.connect();

    const config = await loadConfig(cwd);
    const session = new AgentSession({
      agent,
      command: agent,
      cwd,
      socket,
      sessionId,
      config,
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
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
