# Cadero CLI Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@cadero/cli` — the local daemon that spawns agents under a PTY, intercepts prompts, enforces the safelist, and streams encrypted frames to the relay — plus the two supporting additions it needs: session-key import/export helpers in `@cadero/protocol` and a `POST /v1/pair` endpoint on the relay.

**Architecture:** CLI is an npm-workspaces package on top of the shipped `@cadero/protocol` and `@cadero/relay` from Plan 1. Layering (one responsibility per file): credentials + GitHub device flow → pairing (HTTP + QR) → CaderoSocket (encrypt/decrypt/reconnect) → PTY session → intercept engine + safelist → session orchestration → `cadero-cli` entrypoint. The daemon never executes raw shell from the network; the only PTY writes are prompt text and approval/denial strings appended to the existing agent subshell.

**Tech Stack:** TypeScript strict, Node 20+, npm workspaces, zod, node-pty, ws, qrcode (terminal QR), vitest. Tests use injected `fetch`, a real Redis + real relay instance for socket contract tests, and `bash` as the PTY fixture process.

## Global Constraints

- Node 20 or newer, no exceptions.
- TypeScript strict mode in every package, `tsc --noEmit` must pass (root `npm run typecheck`).
- npm workspaces, package names `@cadero/protocol`, `@cadero/relay`, `@cadero/cli`.
- Real Redis required; no in-memory fallbacks in implementation or tests.
- Local final veto (spec §4): the daemon never executes raw shell from the network. The only PTY writes are prompt text from `EXECUTE_AGENT_PROMPT` and decision strings from `RESOLVE_INTERCEPT`, appended to the existing agent subshell.
- Zero-knowledge transport: the daemon encrypts with the session AES key before sending; only the QR on the user's terminal ever carries the key.
- Fail fast: missing agent binary, unreachable relay, failed auth, or missing credentials all exit with a clear error. No silent degradation, no dev bypasses.
- Repo conventions: named `import { Redis }` from ioredis where needed; no `esModuleInterop`; log frame bodies never (use `redactForLog`-style messages).
- Existing interfaces available (Plan 1, exact names): `@cadero/protocol` exports `WireEventSchema`, `WireEvent`, `TerminalDataSchema`, `InterceptRequiredSchema`, `ResolveInterceptSchema`, `ExecuteAgentPromptSchema`, `EncryptedEnvelopeSchema`, `EncryptedEnvelope`, `generateSessionKey()`, `encryptEnvelope(roomId, key, event)`, `decryptEnvelope(key, envelope)`. `@cadero/relay` exports `createServer({ redisUrl, verifyUser? })`, `createRoomStore(redisUrl)`, `runMain({ env? })`. Relay close codes: 4401 unauthorized, 4404 unknown room.

---

### Task 1: Protocol session-key helpers + typed EnvelopeError

**Files:**
- Create: `packages/protocol/src/keys.ts`
- Modify: `packages/protocol/src/envelope.ts`
- Modify: `packages/protocol/src/index.ts` (append one export line)
- Test: `packages/protocol/tests/keys.test.ts`

**Interfaces:**
- Consumes: `generateSessionKey`, `decryptEnvelope`, `EncryptedEnvelope` from existing `envelope.ts`.
- Produces (used by Tasks 5, 6, and the mobile plan): `importSessionKey(rawBase64Url: string): Promise<CryptoKey>`, `exportSessionKey(key: CryptoKey): Promise<string>` (base64url, raw 32 bytes), `class EnvelopeError extends Error` with `reason: "malformed_envelope" | "decryption_failed" | "invalid_event"`, `decryptEnvelope` upgraded to throw `EnvelopeError` with those reasons, and `encryptRaw(roomId: string, key: CryptoKey, plaintext: string): Promise<EncryptedEnvelope>` (test seam, also reused by the mobile plan's tooling).

- [ ] **Step 1: Write the failing test**

```ts
// packages/protocol/tests/keys.test.ts
import { describe, expect, it } from "vitest";
import {
  decryptEnvelope,
  encryptEnvelope,
  encryptRaw,
  EnvelopeError,
  exportSessionKey,
  generateSessionKey,
  importSessionKey,
} from "../src/index.js";

const event = {
  event: "TERMINAL_DATA",
  meta: { session_id: "sess_1" },
  payload: { chunk: "hello" },
} as const;

describe("session key helpers", () => {
  it("round-trips a key through export and import", async () => {
    const key = await generateSessionKey();
    const raw = await exportSessionKey(key);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const imported = await importSessionKey(raw);
    const envelope = await encryptEnvelope("room_1", imported, event);
    const back = await decryptEnvelope(imported, envelope);
    expect(back).toEqual(event);
  });
});

describe("EnvelopeError", () => {
  it("reports decryption_failed for a wrong key", async () => {
    const key = await generateSessionKey();
    const other = await generateSessionKey();
    const envelope = await encryptEnvelope("room_1", key, event);
    try {
      await decryptEnvelope(other, envelope);
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeError);
      expect((err as EnvelopeError).reason).toBe("decryption_failed");
    }
  });

  it("reports malformed_envelope for a bad shape", async () => {
    const key = await generateSessionKey();
    try {
      await decryptEnvelope(key, { room_id: "room_1", iv: "", ciphertext: "" });
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeError);
      expect((err as EnvelopeError).reason).toBe("malformed_envelope");
    }
  });

  it("reports invalid_event for undecryptable JSON payload", async () => {
    const key = await generateSessionKey();
    const envelope = await encryptEnvelope("room_1", key, event);
    const tampered = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -4) + "AAAA" };
    try {
      await decryptEnvelope(key, tampered);
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeError);
      expect((err as EnvelopeError).reason).toBe("decryption_failed");
    }
  });

  it("reports invalid_event when plaintext is not a wire event", async () => {
    const key = await generateSessionKey();
    const env = await encryptRaw("room_1", key, JSON.stringify({ nope: true }));
    try {
      await decryptEnvelope(key, env);
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeError);
      expect((err as EnvelopeError).reason).toBe("invalid_event");
    }
  });
});
```

`encryptRaw` is the raw-encrypt seam the fourth test uses; it is exported from the barrel and reused by the mobile plan's tooling.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadero/protocol`
Expected: FAIL with "Cannot find module '../src/keys.js'" (or missing `encryptRaw` export).

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/protocol/src/keys.ts
export async function importSessionKey(rawBase64Url: string): Promise<CryptoKey> {
  const bytes = Buffer.from(rawBase64Url, "base64url");
  if (bytes.byteLength !== 32) {
    throw new Error("session key must be 32 raw bytes");
  }
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return crypto.subtle.importKey("raw", out, "AES-GCM", true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function exportSessionKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return Buffer.from(new Uint8Array(raw)).toString("base64url");
}
```

In `packages/protocol/src/envelope.ts`, add the error class and rework `decryptEnvelope`, and factor the raw-encrypt seam:

```ts
export class EnvelopeError extends Error {
  constructor(
    public readonly reason:
      | "malformed_envelope"
      | "decryption_failed"
      | "invalid_event",
    message: string,
  ) {
    super(message);
    this.name = "EnvelopeError";
  }
}

export async function encryptRaw(
  roomId: string,
  key: CryptoKey,
  plaintext: string,
): Promise<EncryptedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(plaintext),
  );
  return {
    room_id: roomId,
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encoded)),
  };
}

export async function encryptEnvelope(
  roomId: string,
  key: CryptoKey,
  event: WireEvent,
): Promise<EncryptedEnvelope> {
  return encryptRaw(roomId, key, JSON.stringify(event));
}

export async function decryptEnvelope(
  key: CryptoKey,
  envelope: EncryptedEnvelope,
): Promise<WireEvent> {
  const parsed = EncryptedEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new EnvelopeError("malformed_envelope", "envelope failed schema validation");
  }
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(parsed.data.iv) },
      key,
      fromBase64(parsed.data.ciphertext),
    );
  } catch {
    throw new EnvelopeError("decryption_failed", "envelope failed to decrypt with this key");
  }
  let parsedEvent: unknown;
  try {
    parsedEvent = JSON.parse(textDecoder.decode(plain));
  } catch {
    throw new EnvelopeError("invalid_event", "decrypted payload is not JSON");
  }
  const event = WireEventSchema.safeParse(parsedEvent);
  if (!event.success) {
    throw new EnvelopeError("invalid_event", "decrypted payload is not a wire event");
  }
  return event.data;
}
```

Append to `packages/protocol/src/index.ts`:

```ts
export * from "./keys.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build --workspace=@cadero/protocol && npm test --workspace=@cadero/protocol && npm test --workspace=@cadero/relay && npm run typecheck`
Expected: protocol tests pass (including all Plan 1 tests — the old "wrong key rejects" test still passes because EnvelopeError extends Error), relay 12/12, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/keys.ts packages/protocol/src/envelope.ts packages/protocol/src/index.ts packages/protocol/tests/keys.test.ts
git commit -m "feat(protocol): session key import/export and typed EnvelopeError"
```

### Task 2: Relay `POST /v1/pair` endpoint

**Files:**
- Modify: `packages/relay/src/server.ts`
- Test: `packages/relay/tests/pair.test.ts`

**Interfaces:**
- Consumes: `createServer(options)` from Plan 1 (options already carry `redisUrl` and `verifyUser?`), `createRoomStore(redisUrl)` with `roomExists(roomId): Promise<boolean>`.
- Produces (used by Task 5): `POST /v1/pair` with `Authorization: Bearer <token>` → `200 { room_id: "room_<16hex>" }`; `401 { error: "unauthorized" }` on failed verifyUser. Route lives in `createServer` so every consumer gets it.

- [ ] **Step 1: Write the failing test**

```ts
// packages/relay/tests/pair.test.ts
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { createRoomStore } from "../src/rooms.js";

const redisUrl = "redis://127.0.0.1:6379";

describe("POST /v1/pair", () => {
  it("pairs an authenticated token to a fresh room", async () => {
    const app = createServer({ redisUrl, verifyUser: async () => "octocat" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/pair",
      headers: { authorization: "Bearer good" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { room_id: string };
    expect(body.room_id).toMatch(/^room_[0-9a-f]{16}$/);
    const store = createRoomStore(redisUrl);
    expect(await store.roomExists(body.room_id)).toBe(true);
    store.disconnect();
    await app.close();
  });

  it("rejects an unauthenticated token with 401", async () => {
    const app = createServer({
      redisUrl,
      verifyUser: async () => {
        throw new Error("GitHub auth failed");
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/pair",
      headers: { authorization: "Bearer bad" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadero/relay`
Expected: FAIL — 404 on `/v1/pair`.

- [ ] **Step 3: Write minimal implementation**

In `packages/relay/src/server.ts`, inside `createServer`, after the `/health` route:

```ts
import { createRoomStore } from "./rooms.js";

// inside createServer, after /health:
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadero/relay`
Expected: all relay tests pass (previous suites + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/server.ts packages/relay/tests/pair.test.ts
git commit -m "feat(relay): add authenticated room pairing endpoint"
```

### Task 3: CLI package scaffold

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/version.ts`
- Modify: root `package.json` (add `@cadero/cli` to the build script)
- Test: `packages/cli/tests/version.test.ts`

**Interfaces:**
- Consumes: nothing yet.
- Produces: package `@cadero/cli` with bin `cadero-cli`, tsconfig, and `export const CADERO_VERSION = "0.1.0"` from `src/version.ts`. Root build script builds protocol, relay, and cli.

- [ ] **Step 1: Write package manifest and configs**

`packages/cli/package.json`:

```json
{
  "name": "@cadero/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": { "cadero-cli": "./dist/main.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@cadero/protocol": "0.1.0",
    "node-pty": "^1.0.0",
    "qrcode": "^1.5.4",
    "ws": "^8.18.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/qrcode": "^1.5.5",
    "@types/ws": "^8.5.12"
  }
}
```

`packages/cli/tsconfig.json` (same shape as the other packages):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

Note: tests are excluded from build (relay precedent); vitest checks them at transform time.

- [ ] **Step 2: Add the version module and its test**

```ts
// packages/cli/src/version.ts
export const CADERO_VERSION = "0.1.0";
```

```ts
// packages/cli/tests/version.test.ts
import { describe, expect, it } from "vitest";
import { CADERO_VERSION } from "../src/version.js";

describe("version", () => {
  it("matches the package version", () => {
    expect(CADERO_VERSION).toBe("0.1.0");
  });
});
```

- [ ] **Step 3: Update root build script and install**

Root `package.json` scripts.build becomes:

```json
"build": "npm run build --workspace=@cadero/protocol && npm run build --workspace=@cadero/relay && npm run build --workspace=@cadero/cli"
```

Run: `npm install && npm run build && npm test --workspace=@cadero/cli && npm run typecheck`
Expected: install succeeds (node-pty prebuilds for macOS), build green, 1/1 test passes, typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/package.json packages/cli/tsconfig.json packages/cli/src/version.ts packages/cli/tests/version.test.ts package.json package-lock.json
git commit -m "chore(cli): scaffold @cadero/cli package with cadero-cli bin"
```

### Task 4: GitHub device-flow login + credential store

**Files:**
- Create: `packages/cli/src/ghDevice.ts`
- Create: `packages/cli/src/credentials.ts`
- Test: `packages/cli/tests/ghDevice.test.ts`
- Test: `packages/cli/tests/credentials.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (used by Tasks 5 and 10): `requestDeviceCode(fetchImpl: typeof fetch): Promise<{ device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number }>`; `pollForAccessToken(fetchImpl: typeof fetch, deviceCode: string, opts: { interval: number; expiresIn: number; onUserCodeShown?: () => void }): Promise<string>` handling `authorization_pending`, `slow_down` (+5s), and expiry (`Error "device code expired"`); `loadCredentials(dir: string): Promise<{ githubToken: string } | null>`; `saveCredentials(dir: string, creds: { githubToken: string }): Promise<void>` (file mode 0600); `CADERO_DIR_DEFAULT = path.join(os.homedir(), ".cadero")`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/tests/ghDevice.test.ts
import { describe, expect, it, vi } from "vitest";
import { pollForAccessToken, requestDeviceCode } from "../src/ghDevice.js";

function jsonFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = routes[url];
    if (body === undefined) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe("requestDeviceCode", () => {
  it("returns the device code bundle", async () => {
    const fetchImpl = jsonFetch({
      "https://github.com/login/device/code": {
        device_code: "dev123",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        interval: 5,
        expires_in: 900,
      },
    });
    const res = await requestDeviceCode(fetchImpl);
    expect(res.user_code).toBe("ABCD-1234");
    expect(res.interval).toBe(5);
  });
});

describe("pollForAccessToken", () => {
  it("waits through pending then returns the token", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const body =
        calls === 1 ? { error: "authorization_pending" } : { access_token: "tok123" };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const token = await pollForAccessToken(fetchImpl, "dev123", {
      interval: 1,
      expiresIn: 30,
    });
    expect(token).toBe("tok123");
    expect(calls).toBe(2);
  });

  it("slows down by 5 seconds on slow_down", async () => {
    const sleep = vi.fn();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const body =
        calls === 1 ? { error: "slow_down" } : { access_token: "tok" };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    // inject sleep via opts for testability
    const token = await pollForAccessToken(fetchImpl, "dev123", {
      interval: 1,
      expiresIn: 30,
      sleep: sleep as unknown as (ms: number) => Promise<void>,
    });
    expect(token).toBe("tok");
    expect(sleep).toHaveBeenCalledWith(6000);
  });

  it("throws when the device code expires", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "authorization_pending" }), {
        status: 200,
      })) as typeof fetch;
    await expect(
      pollForAccessToken(fetchImpl, "dev123", {
        interval: 1,
        expiresIn: 2,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow("device code expired");
  });
});
```

```ts
// packages/cli/tests/credentials.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCredentials, saveCredentials } from "../src/credentials.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("credentials", () => {
  it("saves and loads credentials with 0600 permissions", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-creds-"));
    await saveCredentials(dir, { githubToken: "tok123" });
    expect(await loadCredentials(dir)).toEqual({ githubToken: "tok123" });
    const stat = (await import("node:fs")).statSync(join(dir, "credentials.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("returns null when no credentials exist", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-creds-"));
    expect(await loadCredentials(dir)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@cadero/cli`
Expected: FAIL with "Cannot find module '../src/ghDevice.js'" and '../src/credentials.js'.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/ghDevice.ts
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const CLIENT_ID = "REGISTERED_GITHUB_APP_CLIENT_ID_REQUIRED";

interface DeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  interval?: number;
  expires_in?: number;
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expiresIn: number;
}

export async function requestDeviceCode(fetchImpl: typeof fetch): Promise<DeviceCode> {
  const res = await fetchImpl(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "cadero-cli",
    },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
  });
  if (!res.ok) throw new Error(`device code request failed: HTTP ${res.status}`);
  const body = (await res.json()) as DeviceCodeResponse;
  if (
    typeof body.device_code !== "string" ||
    typeof body.user_code !== "string" ||
    typeof body.verification_uri !== "string"
  ) {
    throw new Error("device code response missing required fields");
  }
  return {
    device_code: body.device_code,
    user_code: body.user_code,
    verification_uri: body.verification_uri,
    interval: body.interval ?? 5,
    expiresIn: body.expires_in ?? 900,
  };
}

interface TokenResponse {
  access_token?: string;
  error?: string;
}

export interface PollOptions {
  interval: number;
  expiresIn: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function pollForAccessToken(
  fetchImpl: typeof fetch,
  deviceCode: string,
  opts: PollOptions,
): Promise<string> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + opts.expiresIn * 1000;
  let current = opts.interval;
  while (Date.now() < deadline) {
    await sleep(current * 1000);
    const res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "cadero-cli",
      },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const body = (await res.json()) as TokenResponse;
    if (typeof body.access_token === "string" && body.access_token.length > 0) {
      return body.access_token;
    }
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      current += 5;
      continue;
    }
    throw new Error(body.error ? `device flow error: ${body.error}` : "device flow failed");
  }
  throw new Error("device code expired");
}
```

Note: `CLIENT_ID` must be the real registered GitHub App client ID before any real login run. It is a deploy-time constant this plan cannot know; the constant name above is deliberately loud so a real run fails at GitHub with `device flow error: unauthorized_client` instead of half-working. Task 10 documents the merge-time requirement.

```ts
// packages/cli/src/credentials.ts
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CADERO_DIR_DEFAULT = join(homedir(), ".cadero");

export interface Credentials {
  githubToken: string;
}

function credentialsPath(dir: string): string {
  return join(dir, "credentials.json");
}

export async function saveCredentials(
  dir: string,
  creds: Credentials,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(credentialsPath(dir), JSON.stringify(creds, null, 2), {
    mode: 0o600,
  });
  // Enforce even when the file already existed (write mode is ignored then).
  await chmod0600(credentialsPath(dir));
}

async function chmod0600(path: string): Promise<void> {
  const info = await stat(path);
  if ((info.mode & 0o777) !== 0o600) {
    const { chmod } = await import("node:fs/promises");
    await chmod(path, 0o600);
  }
}

export async function loadCredentials(dir: string): Promise<Credentials | null> {
  let raw: string;
  try {
    raw = await readFile(credentialsPath(dir), "utf8");
  } catch {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("githubToken" in parsed) ||
    typeof (parsed as { githubToken: unknown }).githubToken !== "string"
  ) {
    throw new Error(`invalid credentials file at ${credentialsPath(dir)}`);
  }
  return parsed as Credentials;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadero/cli && npm run typecheck`
Expected: all CLI tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ghDevice.ts packages/cli/src/credentials.ts packages/cli/tests/ghDevice.test.ts packages/cli/tests/credentials.test.ts
git commit -m "feat(cli): add github device flow login and credential store"
```

### Task 5: Pairing + QR payload

**Files:**
- Create: `packages/cli/src/pairing.ts`
- Test: `packages/cli/tests/pairing.test.ts`

**Interfaces:**
- Consumes: `generateSessionKey`, `exportSessionKey`, `importSessionKey` from `@cadero/protocol` (Task 1); relay `POST /v1/pair` (Task 2).
- Produces (used by Tasks 9, 10): `pairSession(relayUrl: string, githubToken: string, fetchImpl?: typeof fetch): Promise<{ roomId: string; sessionKey: CryptoKey; qrPayload: string }>` where `qrPayload` is `cadero://pair?v=1&relay=<url>&room=<roomId>&key=<base64url raw key>`; `parsePairingPayload(payload: string): { relay: string; room: string; key: string }` (throws `Error "not a cadero pairing payload"` on anything else) — the mobile plan consumes `parsePairingPayload` for its QR-scan side.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/tests/pairing.test.ts
import { describe, expect, it } from "vitest";
import {
  decryptEnvelope,
  encryptEnvelope,
  exportSessionKey,
  importSessionKey,
} from "@cadero/protocol";
import { pairSession, parsePairingPayload } from "../src/pairing.js";

describe("pairSession", () => {
  it("pairs via the relay and emits a parseable QR payload", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://relay.example.com/v1/pair");
      expect(init?.method).toBe("POST");
      const auth = (init?.headers as Record<string, string>).authorization;
      expect(auth).toBe("Bearer tok123");
      return new Response(JSON.stringify({ room_id: "room_abc123def4567890" }), {
        status: 200,
      });
    }) as typeof fetch;

    const { roomId, sessionKey, qrPayload } = await pairSession(
      "https://relay.example.com",
      "tok123",
      fetchImpl,
    );
    expect(roomId).toBe("room_abc123def4567890");
    const parsed = parsePairingPayload(qrPayload);
    expect(parsed.relay).toBe("https://relay.example.com");
    expect(parsed.room).toBe("room_abc123def4567890");
    // The QR key imports to a key that decrypts what the session key encrypts.
    const imported = await importSessionKey(parsed.key);
    expect(await exportSessionKey(imported)).toBe(parsed.key);
    const env = await encryptEnvelope(roomId, sessionKey, {
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_1" },
      payload: { chunk: "x" },
    });
    const back = await decryptEnvelope(imported, env);
    expect(back).toEqual({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_1" },
      payload: { chunk: "x" },
    });
  });

  it("fails loudly on an unauthorized pair", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      })) as typeof fetch;
    await expect(pairSession("https://relay.example.com", "bad", fetchImpl)).rejects.toThrow(
      "pairing failed: HTTP 401",
    );
  });
});

describe("parsePairingPayload", () => {
  it("rejects foreign payloads", () => {
    expect(() => parsePairingPayload("https://example.com")).toThrow(
      "not a cadero pairing payload",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadero/cli`
Expected: FAIL with "Cannot find module '../src/pairing.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/pairing.ts
import {
  exportSessionKey,
  generateSessionKey,
  importSessionKey,
} from "@cadero/protocol";

export interface PairingInfo {
  roomId: string;
  sessionKey: CryptoKey;
  qrPayload: string;
}

export async function pairSession(
  relayUrl: string,
  githubToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PairingInfo> {
  const res = await fetchImpl(`${relayUrl}/v1/pair`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken}`,
      "User-Agent": "cadero-cli",
    },
  });
  if (!res.ok) {
    throw new Error(`pairing failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { room_id?: unknown };
  if (typeof body.room_id !== "string" || body.room_id.length === 0) {
    throw new Error("pairing response missing room_id");
  }
  const roomId = body.room_id;
  const sessionKey = await generateSessionKey();
  const raw = await exportSessionKey(sessionKey);
  const qrPayload = `cadero://pair?v=1&relay=${encodeURIComponent(relayUrl)}&room=${encodeURIComponent(roomId)}&key=${raw}`;
  return { roomId, sessionKey, qrPayload };
}

export interface ParsedPairing {
  relay: string;
  room: string;
  key: string;
}

export function parsePairingPayload(payload: string): ParsedPairing {
  let url: URL;
  try {
    url = new URL(payload);
  } catch {
    throw new Error("not a cadero pairing payload");
  }
  if (url.protocol !== "cadero:" || url.hostname !== "pair" || url.searchParams.get("v") !== "1") {
    throw new Error("not a cadero pairing payload");
  }
  const relay = url.searchParams.get("relay");
  const room = url.searchParams.get("room");
  const key = url.searchParams.get("key");
  if (!relay || !room || !key) {
    throw new Error("not a cadero pairing payload");
  }
  return { relay, room, key };
}

// Re-export so mobile-side tooling and tests can import from one place.
export { importSessionKey };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadero/cli && npm run typecheck`
Expected: CLI tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/pairing.ts packages/cli/tests/pairing.test.ts
git commit -m "feat(cli): add relay pairing and QR payload"
```

### Task 6: CaderoSocket — encrypted websocket client with reconnect

**Files:**
- Create: `packages/cli/src/socket.ts`
- Test: `packages/cli/tests/socket.test.ts`

**Interfaces:**
- Consumes: `encryptEnvelope`, `decryptEnvelope`, `EnvelopeError`, `WireEvent`, `WireEventSchema`, `EncryptedEnvelope` from `@cadero/protocol`; relay `createServer` + `createRoomStore` (contract tests); close codes 4401/4404 from Plan 1.
- Produces (used by Task 9): `class CaderoSocket` with:
  - `constructor(opts: { relayUrl: string; roomId: string; token: string; sessionKey: CryptoKey; sessionId: string; onClose?: (code: number, reason: string) => void })`
  - `connect(): Promise<void>` — resolves on open; wss:// for https, ws:// for http; URL `…/v1/stream?room_id=…&token=…`
  - `onEvent(handler: (event: WireEvent) => void): void`
  - `send(event: WireEvent): Promise<void>` — sets `meta.session_id` to sessionId and `meta.timestamp` to epoch seconds if absent, encrypts, sends; throws if socket is not open
  - `close(): Promise<void>`
  - `onFatal` option: invoked (instead of throwing) when a received frame fails decryption — a wrong key is fatal (broken pairing); the socket stops reconnecting and closes.
  - Reconnect: automatic with exponential backoff 1s, 2s, 4s … capped at 30s, reset to 1s after a successful open; frames produced while disconnected are dropped (never queued — spec §6); 4401/4404 close codes disable reconnect and surface via `onClose`.

- [ ] **Step 1: Write the failing test (real relay + real Redis contract test)**

```ts
// packages/cli/tests/socket.test.ts
import { describe, expect, it } from "vitest";
import {
  exportSessionKey,
  generateSessionKey,
  importSessionKey,
} from "@cadero/protocol";
import { createServer } from "@cadero/relay/server.js";
import { createRoomStore } from "@cadero/relay/rooms.js";
import { CaderoSocket } from "../src/socket.js";

const redisUrl = "redis://127.0.0.1:6379";

function onceEvent(socket: CaderoSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.onEvent((event) => resolve(event));
  });
}

describe("CaderoSocket against the real relay", () => {
  it("sends and receives decrypted wire events and reconnects after drop", async () => {
    const store = createRoomStore(redisUrl);
    const roomId = await store.createRoom();
    store.disconnect();

    const app = createServer({ redisUrl, verifyUser: async () => "cli" });
    await app.listen({ port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const relayUrl = `http://127.0.0.1:${port}`;

    const sessionKey = await generateSessionKey();
    const cli = new CaderoSocket({
      relayUrl,
      roomId,
      token: "t",
      sessionKey,
      sessionId: "sess_cli",
    });
    await cli.connect();

    // A peer (the "phone" role) joins with its own import of the same key.
    const rawKey = await importSessionKey(await exportSessionKey(sessionKey));
    const phone = new CaderoSocket({
      relayUrl,
      roomId,
      token: "t",
      sessionKey: rawKey,
      sessionId: "sess_phone",
    });
    const received = onceEvent(phone);
    await phone.connect();

    await cli.send({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_cli" },
      payload: { chunk: "hello phone" },
    });
    expect(await received).toEqual({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_cli" },
      payload: { chunk: "hello phone" },
    });

    // Phone -> CLI direction.
    const cliReceived = onceEvent(cli);
    await phone.send({
      event: "RESOLVE_INTERCEPT",
      meta: { session_id: "sess_cli" },
      payload: { decision: "APPROVE", input_payload: null },
    });
    expect(await cliReceived).toEqual({
      event: "RESOLVE_INTERCEPT",
      meta: { session_id: "sess_cli" },
      payload: { decision: "APPROVE", input_payload: null },
    });

    // Reconnect: closing the relay kills sockets; CaderoSocket retries
    // with backoff and rejoins a restarted relay on the same port.
    await app.close();
    const app2 = createServer({ redisUrl, verifyUser: async () => "cli" });
    await app2.listen({ port });
    const back = onceEvent(cli);
    await new Promise((r) => setTimeout(r, 2500));
    await phone.send({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_phone" },
      payload: { chunk: "after reconnect" },
    });
    expect(await back).toEqual({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_phone" },
      payload: { chunk: "after reconnect" },
    });

    await cli.close();
    await phone.close();
    await app2.close();
  }, 30000);
});
```

The relay package currently has no `exports` map; add one in `packages/relay/package.json` so `@cadero/relay/server.js` and `@cadero/relay/rooms.js` import cleanly:

```json
"exports": {
  ".": "./dist/index.js",
  "./server": "./dist/server.js",
  "./rooms": "./dist/rooms.js",
  "./auth": "./dist/auth.js",
  "./socket": "./dist/socket.js",
  "./logging": "./dist/logging.js",
  "./main": "./dist/main.js"
},
```

and create `packages/relay/src/index.ts` with `export * from "./server.js";` if it does not exist. Build relay before running CLI tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build --workspace=@cadero/relay && npm test --workspace=@cadero/cli`
Expected: FAIL with "Cannot find module '../src/socket.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/socket.ts
import WebSocket from "ws";
import {
  decryptEnvelope,
  encryptEnvelope,
  EnvelopeError,
  type EncryptedEnvelope,
  type WireEvent,
} from "@cadero/protocol";

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

export interface CaderoSocketOptions {
  relayUrl: string;
  roomId: string;
  token: string;
  sessionKey: CryptoKey;
  sessionId: string;
  onClose?: (code: number, reason: string) => void;
  onFatal?: (error: EnvelopeError) => void;
}

export class CaderoSocket {
  private readonly opts: CaderoSocketOptions;
  private ws: WebSocket | undefined;
  private backoffMs = BASE_BACKOFF_MS;
  private closedByUser = false;
  private reconnectDisabled = false;
  private eventHandler: ((event: WireEvent) => void) | undefined;
  private connecting: Promise<void> | undefined;

  constructor(opts: CaderoSocketOptions) {
    this.opts = opts;
  }

  onEvent(handler: (event: WireEvent) => void): void {
    this.eventHandler = handler;
  }

  private streamUrl(): string {
    const url = new URL(this.opts.relayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/v1/stream";
    url.searchParams.set("room_id", this.opts.roomId);
    url.searchParams.set("token", this.opts.token);
    return url.toString();
  }

  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.streamUrl());
      this.ws = ws;
      ws.on("open", () => {
        settled = true;
        this.backoffMs = BASE_BACKOFF_MS;
        resolve();
      });
      ws.on("message", (data) => this.handleRaw(data.toString()));
      ws.on("close", (code, reason) => this.handleClose(code, reason.toString()));
      ws.on("error", () => {
        if (!settled) {
          settled = true;
          reject(new Error("relay connection failed"));
        }
        // open sockets: the close event follows; reconnect lives in handleClose
      });
    });
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private handleRaw(raw: string): void {
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return; // transport garbage: drop silently
    }
    void decryptEnvelope(this.opts.sessionKey, envelope as EncryptedEnvelope)
      .then((event) => this.eventHandler?.(event))
      .catch((err: unknown) => {
        if (err instanceof EnvelopeError && err.reason === "decryption_failed") {
          // Wrong key is fatal: the pairing is broken. Surface, never hide.
          this.reconnectDisabled = true;
          this.opts.onFatal?.(err);
          this.ws?.close();
          return;
        }
        // invalid_event / malformed_envelope: drop the frame
      });
  }

  private handleClose(code: number, reason: string): void {
    if (code === 4401 || code === 4404) {
      this.reconnectDisabled = true;
      this.opts.onClose?.(code, reason);
      return;
    }
    if (this.closedByUser || this.reconnectDisabled) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    setTimeout(() => {
      void this.connect().catch(() => {
        // connection refused: the close handler already scheduled the next retry
      });
    }, delay);
  }

  async send(event: WireEvent): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("socket is not open; frame dropped (no offline queue)");
    }
    const stamped: WireEvent = {
      ...event,
      meta: {
        ...event.meta,
        session_id: this.opts.sessionId,
        timestamp: Math.floor(Date.now() / 1000),
      },
    };
    const envelope = await encryptEnvelope(this.opts.roomId, this.opts.sessionKey, stamped);
    ws.send(JSON.stringify(envelope));
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    const ws = this.ws;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build --workspace=@cadero/relay && npm run build --workspace=@cadero/protocol && npm test --workspace=@cadero/cli && npm run typecheck`
Expected: the reconnect contract test passes within 30s; typecheck clean. If the reconnect leg is flaky, the backoff reset on open plus the 2500ms wait are the dials — do not add jitter (determinism beats masking in tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/socket.ts packages/cli/tests/socket.test.ts packages/relay/package.json packages/relay/src/index.ts
git commit -m "feat(cli): add encrypted relay socket with reconnect"
```

### Task 7: PTY session manager

**Files:**
- Create: `packages/cli/src/pty.ts`
- Test: `packages/cli/tests/pty.test.ts`

**Interfaces:**
- Consumes: node-pty.
- Produces (used by Task 9): `interface PtySession { onData(cb: (chunk: string) => void): void; onExit(cb: (code: number) => void): void; write(input: string): void; kill(): void; }` and `createPtySession(opts: { command: string; args?: string[]; cwd: string; cols?: number; rows?: number }): PtySession`. Env per spec: `FORCE_COLOR: "3"`, `CADERO_ACTIVE: "true"`, name `xterm-256color`, default 80x24, `cwd` is the invoking directory. A spawn failure surfaces as a thrown `Error` containing `agent '<command>' failed to start` — fail fast, no fallback binary.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/tests/pty.test.ts
import { describe, expect, it } from "vitest";
import { createPtySession } from "../src/pty.js";

function firstChunk(session: { onData(cb: (chunk: string) => void): void }): Promise<string> {
  return new Promise((resolve) => session.onData(resolve));
}

describe("createPtySession", () => {
  it("streams output from a real process", async () => {
    const session = createPtySession({
      command: "bash",
      args: ["-c", "printf hello-pty; exit 0"],
      cwd: process.cwd(),
    });
    const chunk = await firstChunk(session);
    expect(chunk).toContain("hello-pty");
    session.kill();
  });

  it("writes input into the running process", async () => {
    const session = createPtySession({
      command: "bash",
      args: ["-c", "read line; printf \"got:%s\" \"$line\""],
      cwd: process.cwd(),
    });
    await new Promise((r) => setTimeout(r, 300));
    session.write("from-cadero\r");
    const chunk = await firstChunk(session);
    expect(chunk).toContain("got:from-cadero");
    session.kill();
  });

  it("throws a clear error for a missing binary", () => {
    expect(() =>
      createPtySession({ command: "definitely-not-a-real-agent-xyz", cwd: process.cwd() }),
    ).toThrow(/failed to start/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadero/cli`
Expected: FAIL with "Cannot find module '../src/pty.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/pty.ts
import * as pty from "node-pty";

export interface PtySession {
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number) => void): void;
  write(input: string): void;
  kill(): void;
}

export interface PtyOptions {
  command: string;
  args?: string[];
  cwd: string;
  cols?: number;
  rows?: number;
}

export function createPtySession(opts: PtyOptions): PtySession {
  let proc: pty.IPty;
  try {
    proc = pty.spawn(opts.command, opts.args ?? [], {
      name: "xterm-256color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env: {
        ...process.env,
        FORCE_COLOR: "3",
        CADERO_ACTIVE: "true",
      } as { [key: string]: string },
    });
  } catch {
    throw new Error(
      `agent '${opts.command}' failed to start; is it installed and on PATH?`,
    );
  }

  const dataCbs: Array<(chunk: string) => void> = [];
  const exitCbs: Array<(code: number) => void> = [];
  proc.onData((chunk) => {
    for (const cb of dataCbs) cb(chunk);
  });
  proc.onExit(({ exitCode }) => {
    for (const cb of exitCbs) cb(exitCode);
  });

  return {
    onData(cb) {
      dataCbs.push(cb);
    },
    onExit(cb) {
      exitCbs.push(cb);
    },
    write(input) {
      proc.write(input);
    },
    kill() {
      proc.kill();
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadero/cli && npm run typecheck`
Expected: PTY tests pass (the missing-binary test proves fail-fast), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/pty.ts packages/cli/tests/pty.test.ts
git commit -m "feat(cli): add node-pty session manager"
```

### Task 8: Intercept engine + safelist config

**Files:**
- Create: `packages/cli/src/config.ts`
- Create: `packages/cli/src/intercept.ts`
- Test: `packages/cli/tests/config.test.ts`
- Test: `packages/cli/tests/intercept.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Task 9): `type AgentName = "claude" | "opencode"`; `detectIntercept(agent: AgentName, chunk: string): { prompt: string; command: string } | null` — `prompt` is the matched confirmation text (trimmed to 500 chars), `command` is the agent's command line extracted from the non-empty line immediately before the prompt line (falls back to the prompt text when none exists; also trimmed to 500 chars). `isSafeCommand(command: string, safeCommands: string[]): boolean` (exact match after collapsing whitespace). `loadConfig(cwd: string): Promise<{ safeCommands: string[] }>` reading `<cwd>/.caderorc` (JSON `{ "safeCommands": string[] }`; missing file → `{ safeCommands: [] }`; malformed → throws `Error ".caderorc is not valid: <reason>"` — fail fast, no silent default).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/tests/intercept.test.ts
import { describe, expect, it } from "vitest";
import { detectIntercept, isSafeCommand } from "../src/intercept.js";

describe("detectIntercept", () => {
  it("catches claude tool-confirmation prompts and extracts the command", () => {
    const chunk =
      "\u001b[36mClaude wants to run:\u001b[0m\nnpm run build\nDo you want to proceed? [y/N]";
    const hit = detectIntercept("claude", chunk);
    expect(hit).not.toBeNull();
    expect(hit!.prompt).toContain("Do you want to proceed? [y/N]");
    expect(hit!.command).toBe("npm run build");
  });

  it("falls back to the prompt text when no command line precedes it", () => {
    const chunk = "Press Enter to continue";
    const hit = detectIntercept("claude", chunk);
    expect(hit).not.toBeNull();
    expect(hit!.command).toBe("Press Enter to continue");
  });

  it("catches opencode waiting-for-input markers", () => {
    const chunk = "…waiting for your input ›";
    expect(detectIntercept("opencode", chunk)).not.toBeNull();
  });

  it("passes ordinary output through", () => {
    expect(detectIntercept("claude", "I scanned the directory and found 3 files.")).toBeNull();
  });
});

describe("isSafeCommand", () => {
  it("matches after whitespace collapsing", () => {
    expect(isSafeCommand("npm  test", ["npm test"])).toBe(true);
    expect(isSafeCommand("npm run build", ["npm test"])).toBe(false);
  });
});
```

```ts
// packages/cli/tests/config.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("loadConfig", () => {
  it("returns empty safelist when .caderorc is absent", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-cfg-"));
    expect(await loadConfig(dir)).toEqual({ safeCommands: [] });
  });

  it("loads safeCommands from .caderorc", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-cfg-"));
    writeFileSync(
      join(dir, ".caderorc"),
      JSON.stringify({ safeCommands: ["npm test", "git status"] }),
    );
    expect(await loadConfig(dir)).toEqual({ safeCommands: ["npm test", "git status"] });
  });

  it("fails loudly on malformed .caderorc", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-cfg-"));
    writeFileSync(join(dir, ".caderorc"), "{ not json");
    await expect(loadConfig(dir)).rejects.toThrow(".caderorc is not valid");
  });

  it("fails loudly when safeCommands is not a string array", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-cfg-"));
    writeFileSync(join(dir, ".caderorc"), JSON.stringify({ safeCommands: "npm test" }));
    await expect(loadConfig(dir)).rejects.toThrow(".caderorc is not valid");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@cadero/cli`
Expected: FAIL with "Cannot find module '../src/intercept.js'" and '../src/config.js'.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/intercept.ts
export type AgentName = "claude" | "opencode";

const CLAUDE_PATTERNS: RegExp[] = [
  /Do you want to (make|proceed|run|execute)[^\n?]*\?[^\n]*/i,
  /\[(y\/N|Y\/n|yes\/no)\]\s*$/i,
  /Press Enter to continue[^\n]*/i,
  /Allow[^\n?]*\?[^\n]*/i,
];

const OPENCODE_PATTERNS: RegExp[] = [
  /waiting for (your )?input[^\n]*/i,
  /\[Y\/n\][^\n]*/i,
];

export interface InterceptHit {
  prompt: string;
  command: string;
}

function trim500(value: string): string {
  return value.trim().slice(0, 500);
}

function extractCommand(chunk: string, promptStartIndex: number): string {
  const before = chunk.slice(0, promptStartIndex);
  const lines = before.split("\n").map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].length > 0) return trim500(lines[i]);
  }
  return "";
}

export function detectIntercept(
  agent: AgentName,
  chunk: string,
): InterceptHit | null {
  const patterns = agent === "claude" ? CLAUDE_PATTERNS : OPENCODE_PATTERNS;
  for (const pattern of patterns) {
    const match = chunk.match(pattern);
    if (match && match.index !== undefined) {
      const prompt = trim500(match[0]);
      const command = extractCommand(chunk, match.index) || prompt;
      return { prompt, command };
    }
  }
  return null;
}

export function isSafeCommand(command: string, safeCommands: string[]): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  return safeCommands.some((safe) => safe.replace(/\s+/g, " ").trim() === normalized);
}
```

```ts
// packages/cli/src/config.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const CaderoRcSchema = z.object({
  safeCommands: z.array(z.string().min(1)).max(100).default([]),
});

export interface CaderoConfig {
  safeCommands: string[];
}

export async function loadConfig(cwd: string): Promise<CaderoConfig> {
  const path = join(cwd, ".caderorc");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { safeCommands: [] };
  }
  const parsed = CaderoRcSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`.caderorc is not valid: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  return parsed.data;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadero/cli && npm run typecheck`
Expected: intercept + config tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/config.ts packages/cli/src/intercept.ts packages/cli/tests/config.test.ts packages/cli/tests/intercept.test.ts
git commit -m "feat(cli): add intercept engine and safelist config"
```

### Task 9: Session orchestration

**Files:**
- Create: `packages/cli/src/session.ts`
- Test: `packages/cli/tests/session.test.ts`

**Interfaces:**
- Consumes: `createPtySession` (Task 7), `detectIntercept`, `isSafeCommand` (Task 8), `CaderoSocket` (Task 6), `loadConfig` (Task 8), wire-event types from `@cadero/protocol`.
- Produces (used by Task 10): `class AgentSession` with:
  - `constructor(opts: { agent: AgentName; command: string; args?: string[]; cwd: string; socket: CaderoSocket; sessionId: string; config: { safeCommands: string[] }; autoApproveText?: string })`
  - `start(): void` — spawns the PTY
  - `stop(): void`
  - Semantics (spec §1.2 + §4): PTY chunk → if an intercept is already pending, buffer the chunk (stream paused); else `detectIntercept` → hit + safe (`isSafeCommand(hit.command, config.safeCommands)`) → auto-approve by writing `autoApproveText ?? "y\r"` into the PTY and forwarding the chunk as `TERMINAL_DATA`; hit + not safe → send `INTERCEPT_REQUIRED` (`agent`, `reason: "EXECUTE_COMMAND"`, `command: hit.command`) and pause the stream (buffer chunks); no hit → forward as `TERMINAL_DATA`.
  - `RESOLVE_INTERCEPT` → `APPROVE` writes `"y\r"`, `DENY` writes `"\u001b"` (Escape), then flushes buffered chunks as `TERMINAL_DATA` and clears pending.
  - `EXECUTE_AGENT_PROMPT` → writes `payload.prompt + "\r"` into the PTY.
  - PTY exit → sends a final `TERMINAL_DATA` with chunk `\n[session exited with code <code>]\n`, then `stop()`.

- [ ] **Step 1: Write the failing test**

Use a `FakeSocket` that records sent events (no network), a real PTY running bash, and a stub agent script that prints a confirmation prompt.

```ts
// packages/cli/tests/session.test.ts
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WireEvent } from "@cadero/protocol";
import { AgentSession } from "../src/session.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

class FakeSocket {
  sent: WireEvent[] = [];
  handler: ((event: WireEvent) => void) | undefined;
  onEvent(handler: (event: WireEvent) => void): void {
    this.handler = handler;
  }
  async send(event: WireEvent): Promise<void> {
    this.sent.push(event);
  }
  last(): WireEvent | undefined {
    return this.sent[this.sent.length - 1];
  }
  async all(count: number, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (this.sent.length < count) {
      if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for events");
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

function stubAgent(dir: string, body: string): string {
  const path = join(dir, "stub-agent.sh");
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("AgentSession", () => {
  it("forwards ordinary output as TERMINAL_DATA", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-sess-"));
    const agent = stubAgent(dir, 'printf "working..."');
    const socket = new FakeSocket();
    const session = new AgentSession({
      agent: "claude",
      command: "bash",
      args: [agent],
      cwd: dir,
      socket: socket as never,
      sessionId: "sess_1",
      config: { safeCommands: [] },
    });
    session.start();
    await socket.all(1);
    expect(socket.sent[0].event).toBe("TERMINAL_DATA");
    session.stop();
  });

  it("intercepts a confirmation and auto-approves safe commands", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-sess-"));
    const agent = stubAgent(
      dir,
      'printf "npm test\\nDo you want to proceed? [y/N]"; read -n 1; printf " done"',
    );
    const socket = new FakeSocket();
    const session = new AgentSession({
      agent: "claude",
      command: "bash",
      args: [agent],
      cwd: dir,
      socket: socket as never,
      sessionId: "sess_1",
      config: { safeCommands: ["npm test"] },
    });
    session.start();
    await socket.all(1);
    // The intercept hit was safe-listed: only the TERMINAL_DATA went out,
    // the approval keystroke was written straight into the PTY, and the
    // post-approval output arrives.
    expect(socket.sent.every((e) => e.event === "TERMINAL_DATA")).toBe(true);
    const chunks = socket.sent
      .map((e) => (e.payload as { chunk: string }).chunk)
      .join("");
    expect(chunks).toContain(" done");
    session.stop();
  });

  it("raises INTERCEPT_REQUIRED for unsafe commands and resumes on APPROVE", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-sess-"));
    const agent = stubAgent(
      dir,
      'printf "rm -rf ./dist && npm run build\\nDo you want to proceed? [y/N]"; read -n 1; printf " continued"',
    );
    const socket = new FakeSocket();
    const session = new AgentSession({
      agent: "claude",
      command: "bash",
      args: [agent],
      cwd: dir,
      socket: socket as never,
      sessionId: "sess_1",
      config: { safeCommands: [] },
    });
    session.start();
    await socket.all(1);
    const intercept = socket.sent.find((e) => e.event === "INTERCEPT_REQUIRED");
    expect(intercept).toBeDefined();
    expect((intercept!.payload as { command: string }).command).toBe(
      "rm -rf ./dist && npm run build",
    );

    // Mobile approves; the y keystroke resumes the agent.
    socket.handler!({
      event: "RESOLVE_INTERCEPT",
      meta: { session_id: "sess_1" },
      payload: { decision: "APPROVE", input_payload: null },
    } as WireEvent);
    await socket.all(3);
    const resumed = socket.sent
      .map((e) => (e.payload as { chunk: string }).chunk)
      .join("");
    expect(resumed).toContain(" continued");
    session.stop();
  });

  it("writes EXECUTE_AGENT_PROMPT input into the pty", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-sess-"));
    const agent = stubAgent(dir, 'read line; printf "prompted:%s" "$line"');
    const socket = new FakeSocket();
    const session = new AgentSession({
      agent: "claude",
      command: "bash",
      args: [agent],
      cwd: dir,
      socket: socket as never,
      sessionId: "sess_1",
      config: { safeCommands: [] },
    });
    session.start();
    await new Promise((r) => setTimeout(r, 300));
    socket.handler!({
      event: "EXECUTE_AGENT_PROMPT",
      meta: { session_id: "sess_1" },
      payload: { prompt: "list the src dir" },
    } as WireEvent);
    await socket.all(1);
    const chunks = socket.sent
      .map((e) => (e.payload as { chunk: string }).chunk)
      .join("");
    expect(chunks).toContain("prompted:list the src dir");
    session.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadero/cli`
Expected: FAIL with "Cannot find module '../src/session.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/session.ts
import type { WireEvent } from "@cadero/protocol";
import { createPtySession, type PtySession } from "./pty.js";
import { detectIntercept, isSafeCommand, type AgentName } from "./intercept.js";

export interface AgentSessionOptions {
  agent: AgentName;
  command: string;
  args?: string[];
  cwd: string;
  socket: Pick<import("./socket.js").CaderoSocket, "send"> & {
    onEvent(handler: (event: WireEvent) => void): void;
  };
  sessionId: string;
  config: { safeCommands: string[] };
  autoApproveText?: string;
}

export class AgentSession {
  private readonly opts: AgentSessionOptions;
  private pty: PtySession | undefined;
  private pending: { command: string } | undefined;
  private buffer = "";

  constructor(opts: AgentSessionOptions) {
    this.opts = opts;
  }

  start(): void {
    this.pty = createPtySession({
      command: this.opts.command,
      args: this.opts.args,
      cwd: this.opts.cwd,
    });
    this.pty.onData((chunk) => void this.handleChunk(chunk));
    this.pty.onExit((code) => void this.handleExit(code));
    this.opts.socket.onEvent((event) => void this.handleRemote(event));
  }

  stop(): void {
    this.pty?.kill();
    this.pty = undefined;
  }

  private async handleChunk(chunk: string): Promise<void> {
    if (this.pending) {
      this.buffer += chunk;
      return; // stream paused behind the pending intercept
    }
    const hit = detectIntercept(this.opts.agent, chunk);
    if (hit) {
      if (isSafeCommand(hit.command, this.opts.config.safeCommands)) {
        this.pty?.write(this.opts.autoApproveText ?? "y\r");
        await this.sendTerminal(chunk);
        return;
      }
      this.pending = hit;
      await this.opts.socket.send({
        event: "INTERCEPT_REQUIRED",
        meta: { session_id: this.opts.sessionId },
        payload: {
          agent: this.opts.agent,
          reason: "EXECUTE_COMMAND",
          command: hit.command,
        },
      });
      return;
    }    await this.sendTerminal(chunk);
  }

  private async handleRemote(event: WireEvent): Promise<void> {
    if (event.event === "RESOLVE_INTERCEPT") {
      if (event.payload.decision === "APPROVE") {
        this.pty?.write(event.payload.input_payload ?? "y\r");
      } else {
        this.pty?.write("\u001b");
      }
      const flushed = this.buffer;
      this.buffer = "";
      this.pending = undefined;
      if (flushed.length > 0) {
        await this.sendTerminal(flushed);
      }
      return;
    }
    if (event.event === "EXECUTE_AGENT_PROMPT") {
      this.pty?.write(`${event.payload.prompt}\r`);
    }
  }

  private async handleExit(code: number): Promise<void> {
    await this.sendTerminal(`\n[session exited with code ${code}]\n`);
    this.pty = undefined;
  }

  private sendTerminal(chunk: string): Promise<void> {
    return this.opts.socket.send({
      event: "TERMINAL_DATA",
      meta: { session_id: this.opts.sessionId },
      payload: { chunk },
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadero/cli && npm run typecheck`
Expected: all session tests pass; if the PTY timing is tight in CI, raise the poll interval in `FakeSocket.all` — do not add sleeps to production code.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/session.ts packages/cli/tests/session.test.ts
git commit -m "feat(cli): add agent session orchestration"
```

### Task 10: `cadero-cli` entrypoint (login + start)

**Files:**
- Create: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/ghDevice.ts` (resolve the `CLIENT_ID` placeholder)
- Test: `packages/cli/tests/main.test.ts`

**Interfaces:**
- Consumes: everything above — `requestDeviceCode`, `pollForAccessToken` (Task 4), `loadCredentials`/`saveCredentials`, `CADERO_DIR_DEFAULT` (Task 4), `pairSession`, `parsePairingPayload` (Task 5), `CaderoSocket` (Task 6), `AgentSession` (Task 9), `loadConfig` (Task 8), `randomBytes` for session ids.
- Produces: `runCli(argv: string[], opts?: { env?: NodeJS.ProcessEnv; caderoDir?: string; cwd?: string; fetchImpl?: typeof fetch; stdout?: (line: string) => void; stderr?: (line: string) => void }): Promise<number>` (exit code); bin `cadero-cli` maps to `dist/main.js` with the self-invocation guard, mapping a thrown error to `stderr` + exit 1. Commands:
  - `cadero-cli login` — device flow: print user_code + verification_uri to stdout, poll, save credentials to `<caderoDir>/credentials.json`, print `logged in as saved to <path>`.
  - `cadero-cli start [--agent claude|opencode] [--relay-url URL]` — requires `CADERO_RELAY_URL` env or `--relay-url` flag (default `https://relay.cadero.dev` is **not** allowed silently: if neither flag nor env is set, exit 1 with `relay URL required: pass --relay-url or set CADERO_RELAY_URL`); loads credentials (missing → `not logged in; run: cadero-cli login`, exit 1); pairs (Task 5); renders the QR payload in the terminal via `qrcode.toString(qrPayload, { type: "terminal" })` to stdout followed by the plain payload line; generates `sess_<8hex>` session id; connects `CaderoSocket`; spawns `AgentSession` with `command` = `--agent` value (default `claude`), `cwd` = `process.cwd()`, config from `loadConfig(cwd)`; SIGINT → clean `stop()` + `close()` + exit 0.
  - `--help` / `-h` → usage text, exit 0. Unknown command → usage on stderr, exit 1.

Task 10 note (from Task 4): replace the `CLIENT_ID` placeholder in `ghDevice.ts` with the real GitHub App client ID. The value must be provided by the human partner at merge time; until registered, keep the placeholder constant but make its name scream: `const CLIENT_ID = "REGISTERED_GITHUB_APP_CLIENT_ID_REQUIRED";` — a real device-flow run against GitHub will then fail loudly with `device flow error: unauthorized_client` rather than half-work.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/tests/main.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/main.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function fakeFetch(routes: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const route = routes[String(input)];
    if (!route) throw new Error(`unexpected fetch: ${String(input)}`);
    return new Response(JSON.stringify(route.body), { status: route.status });
  }) as typeof fetch;
}

describe("runCli", () => {
  it("login runs the device flow and saves credentials", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-main-"));
    const lines: string[] = [];
    const code = await runCli(["login"], {
      caderoDir: dir,
      fetchImpl: fakeFetch({
        "https://github.com/login/device/code": {
          status: 200,
          body: {
            device_code: "dev",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            interval: 1,
            expires_in: 10,
          },
        },
        "https://github.com/login/oauth/access_token": {
          status: 200,
          body: { access_token: "tok123" },
        },
      }),
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("ABCD-1234");
    const { loadCredentials } = await import("../src/credentials.js");
    expect(await loadCredentials(dir)).toEqual({ githubToken: "tok123" });
  });

  it("start without credentials exits 1 with guidance", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-main-"));
    const errs: string[] = [];
    const code = await runCli(["start", "--relay-url", "https://r.example.com"], {
      caderoDir: dir,
      stderr: (line) => errs.push(line),
    });
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("cadero-cli login");
  });

  it("start without a relay URL exits 1", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-main-"));
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({ githubToken: "tok" }));
    const errs: string[] = [];
    const code = await runCli(["start"], { caderoDir: dir, env: {}, stderr: (l) => errs.push(l) });
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("--relay-url");
  });

  it("help exits 0 and prints usage", async () => {
    const out: string[] = [];
    const code = await runCli(["--help"], { stdout: (l) => out.push(l) });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("cadero-cli login");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadero/cli`
Expected: FAIL with "Cannot find module '../src/main.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/main.ts
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadCredentials, saveCredentials, CADERO_DIR_DEFAULT } from "./credentials.js";
import { pollForAccessToken, requestDeviceCode } from "./ghDevice.js";
import { pairSession } from "./pairing.js";
import { CaderoSocket } from "./socket.js";
import { AgentSession } from "./session.js";
import { loadConfig } from "./config.js";
import type { AgentName } from "./intercept.js";

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  caderoDir?: string;
  cwd?: string;
  fetchImpl?: typeof fetch;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
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
    const device = await requestDeviceCode(fetchImpl);
    out(`Open ${device.verification_uri} and enter code: ${device.user_code}`);
    const token = await pollForAccessToken(fetchImpl, device.device_code, {
      interval: device.interval,
      expiresIn: device.expiresIn,
    });
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
    out(await qr.toString(qrPayload, { type: "terminal" }));
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
```

In `packages/cli/src/ghDevice.ts`, replace the placeholder line from Task 4 with:

```ts
const CLIENT_ID = "REGISTERED_GITHUB_APP_CLIENT_ID_REQUIRED";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build --workspace=@cadero/cli && npm test --workspace=@cadero/cli && npm test --workspace=@cadero/protocol && npm test --workspace=@cadero/relay && npm run typecheck`
Expected: everything green — this is the Plan 2 exit gate.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/main.ts packages/cli/src/ghDevice.ts packages/cli/tests/main.test.ts
git commit -m "feat(cli): add cadero-cli login and start entrypoint"
```
