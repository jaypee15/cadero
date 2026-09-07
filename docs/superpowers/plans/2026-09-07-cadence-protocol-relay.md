# Cadence Plan 1: Protocol plus Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared protocol package and the production Fastify plus Redis relay so headless clients can pair rooms and route validated frames.

**Architecture:** `packages/protocol` owns zod schemas and AES-GCM envelope helpers with zero transport code. `packages/relay` owns Fastify, GitHub OAuth verification, Redis room registry with TTL, and pub/sub fanout that reads only the `room_id` header. Real Redis is required everywhere including tests.

**Tech Stack:** TypeScript strict, Node 20+, npm workspaces, zod, Fastify plus @fastify/websocket, ioredis, vitest, ws (test client). GitHub API is stubbed by injecting a fake `fetch` in tests; no HTTP mocking library.

## Global Constraints

- Node 20 or newer, no exceptions.
- TypeScript strict mode in every package, `tsc --noEmit` must pass.
- npm workspaces, package names `@cadence/protocol` and `@cadence/relay`.
- Real Redis required; no in-memory room fallback in implementation or tests.
- Relay never persists payloads and never logs frame bodies.
- Relay never sees plaintext or AES keys; it routes on the `room_id` header only.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `packages/protocol/package.json`
- Create: `packages/protocol/tsconfig.json`
- Create: `packages/relay/package.json`
- Create: `packages/relay/tsconfig.json`

**Interfaces:**
- Consumes: nothing.
- Produces: workspace layout and `npm run typecheck` script that later tasks rely on.

- [ ] **Step 1: Write root package.json**

```json
{
  "name": "cadence",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.base.json"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 3: Write per-package manifests and configs**

`packages/protocol/package.json`:

```json
{
  "name": "@cadence/protocol",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "zod": "^3.23.0"
  }
}
```

`packages/protocol/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src", "tests"]
}
```

`packages/relay/package.json`:

```json
{
  "name": "@cadence/relay",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "node ./dist/server.js"
  },
  "dependencies": {
    "@cadence/protocol": "0.1.0",
    "@fastify/websocket": "^10.0.0",
    "fastify": "^5.0.0",
    "ioredis": "^5.4.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "ws": "^8.18.0"
  }
}
```

`packages/relay/tsconfig.json`: identical shape to the protocol one with its own `outDir` and `rootDir`.

- [ ] **Step 4: Install and typecheck**

Run: `npm install && npm run typecheck`
Expected: install succeeds, typecheck passes with no inputs yet (exit 0).

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.base.json packages/protocol/package.json packages/protocol/tsconfig.json packages/relay/package.json packages/relay/tsconfig.json package-lock.json
git commit -m "chore: scaffold npm workspaces monorepo with protocol and relay packages"
```

### Task 2: Protocol event schemas

**Files:**
- Create: `packages/protocol/src/events.ts`
- Create: `packages/protocol/src/index.ts`
- Create: `packages/protocol/tests/events.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TerminalDataSchema`, `InterceptRequiredSchema`, `ResolveInterceptSchema`, `ExecuteAgentPromptSchema`, `WireEventSchema`, and inferred types `TerminalData`, `InterceptRequired`, `ResolveIntercept`, `ExecuteAgentPrompt`, `WireEvent` used by Tasks 3 through 8.

- [ ] **Step 1: Write the failing test**

```ts
// packages/protocol/tests/events.test.ts
import { describe, expect, it } from "vitest";
import { WireEventSchema } from "../src/events.js";

describe("WireEventSchema", () => {
  it("accepts a TERMINAL_DATA event", () => {
    const parsed = WireEventSchema.safeParse({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_91823", timestamp: 1714838400 },
      payload: { chunk: "hello" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown event name", () => {
    const parsed = WireEventSchema.safeParse({
      event: "RUN_ANYTHING",
      meta: { session_id: "sess_91823" },
      payload: {},
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects RESOLVE_INTERCEPT with a bad decision", () => {
    const parsed = WireEventSchema.safeParse({
      event: "RESOLVE_INTERCEPT",
      meta: { session_id: "sess_91823" },
      payload: { decision: "MAYBE", input_payload: null },
    });
    expect(parsed.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadence/protocol`
Expected: FAIL with "Cannot find module '../src/events.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/protocol/src/events.ts
import { z } from "zod";

const metaSchema = z.object({
  session_id: z.string().min(1),
  timestamp: z.number().int().nonnegative().optional(),
});

export const TerminalDataSchema = z.object({
  event: z.literal("TERMINAL_DATA"),
  meta: metaSchema,
  payload: z.object({ chunk: z.string() }),
});

export const InterceptRequiredSchema = z.object({
  event: z.literal("INTERCEPT_REQUIRED"),
  meta: metaSchema,
  payload: z.object({
    agent: z.enum(["claude", "opencode"]),
    reason: z.string().min(1),
    command: z.string(),
  }),
});

export const ResolveInterceptSchema = z.object({
  event: z.literal("RESOLVE_INTERCEPT"),
  meta: metaSchema,
  payload: z.object({
    decision: z.enum(["APPROVE", "DENY"]),
    input_payload: z.string().nullable(),
  }),
});

export const ExecuteAgentPromptSchema = z.object({
  event: z.literal("EXECUTE_AGENT_PROMPT"),
  meta: metaSchema,
  payload: z.object({ prompt: z.string().min(1).max(20000) }),
});

export const WireEventSchema = z.discriminatedUnion("event", [
  TerminalDataSchema,
  InterceptRequiredSchema,
  ResolveInterceptSchema,
  ExecuteAgentPromptSchema,
]);

export type TerminalData = z.infer<typeof TerminalDataSchema>;
export type InterceptRequired = z.infer<typeof InterceptRequiredSchema>;
export type ResolveIntercept = z.infer<typeof ResolveInterceptSchema>;
export type ExecuteAgentPrompt = z.infer<typeof ExecuteAgentPromptSchema>;
export type WireEvent = z.infer<typeof WireEventSchema>;
```

```ts
// packages/protocol/src/index.ts
export * from "./events.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=@cadence/protocol`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/events.ts packages/protocol/src/index.ts packages/protocol/tests/events.test.ts
git commit -m "feat(protocol): add zod schemas for wire events"
```

### Task 3: Encrypted envelope helpers

**Files:**
- Create: `packages/protocol/src/envelope.ts`
- Create: `packages/protocol/tests/envelope.test.ts`

**Interfaces:**
- Consumes: `WireEvent`, `WireEventSchema` from Task 2.
- Produces: `EncryptedEnvelopeSchema`, type `EncryptedEnvelope`, `generateSessionKey(): Promise<CryptoKey>`, `encryptEnvelope(roomId: string, key: CryptoKey, event: WireEvent): Promise<EncryptedEnvelope>`, `decryptEnvelope(key: CryptoKey, envelope: EncryptedEnvelope): Promise<WireEvent>` used by relay routing (Task 7) and later by CLI and mobile plans.

- [ ] **Step 1: Write the failing test**

```ts
// packages/protocol/tests/envelope.test.ts
import { describe, expect, it } from "vitest";
import {
  decryptEnvelope,
  encryptEnvelope,
  EncryptedEnvelopeSchema,
  generateSessionKey,
  type EncryptedEnvelope,
} from "../src/envelope.js";

const event = {
  event: "TERMINAL_DATA",
  meta: { session_id: "sess_1" },
  payload: { chunk: "secret bytes" },
} as const;

describe("envelope", () => {
  it("round-trips an event through AES-GCM", async () => {
    const key = await generateSessionKey();
    const envelope = await encryptEnvelope("room_abc", key, event);
    expect(EncryptedEnvelopeSchema.safeParse(envelope).success).toBe(true);
    const back = await decryptEnvelope(key, envelope);
    expect(back).toEqual(event);
  });

  it("ciphertext does not contain the plaintext chunk", async () => {
    const key = await generateSessionKey();
    const envelope: EncryptedEnvelope = await encryptEnvelope("room_abc", key, event);
    expect(envelope.ciphertext).not.toContain("secret bytes");
    expect(envelope.room_id).toBe("room_abc");
  });

  it("decryption with the wrong key fails", async () => {
    const key = await generateSessionKey();
    const other = await generateSessionKey();
    const envelope = await encryptEnvelope("room_abc", key, event);
    await expect(decryptEnvelope(other, envelope)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadence/protocol`
Expected: FAIL with "Cannot find module '../src/envelope.js'".

- [ ] **Step 3: Write minimal implementation**

Append the envelope export to the barrel file created in Task 2:

```ts
// packages/protocol/src/index.ts
export * from "./events.js";
export * from "./envelope.js";
```

```ts
// packages/protocol/src/envelope.ts
import { z } from "zod";
import { WireEventSchema, type WireEvent } from "./events.js";

export const EncryptedEnvelopeSchema = z.object({
  room_id: z.string().min(1),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
});

export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(raw: string): Uint8Array {
  return new Uint8Array(Buffer.from(raw, "base64"));
}

export async function generateSessionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptEnvelope(
  roomId: string,
  key: CryptoKey,
  event: WireEvent,
): Promise<EncryptedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(JSON.stringify(event)),
  );
  return {
    room_id: roomId,
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encoded)),
  };
}

export async function decryptEnvelope(
  key: CryptoKey,
  envelope: EncryptedEnvelope,
): Promise<WireEvent> {
  const parsed = EncryptedEnvelopeSchema.parse(envelope);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(parsed.iv) },
    key,
    fromBase64(parsed.ciphertext),
  );
  return WireEventSchema.parse(JSON.parse(textDecoder.decode(plain)));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadence/protocol`
Expected: 6 passed (3 event tests plus 3 envelope tests).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/envelope.ts packages/protocol/src/index.ts packages/protocol/tests/envelope.test.ts
git commit -m "feat(protocol): add AES-GCM envelope helpers"
```

### Task 4: Relay server scaffold with health endpoint

**Files:**
- Create: `packages/relay/src/server.ts`
- Create: `packages/relay/tests/server.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks yet.
- Produces: `createServer(): FastifyInstance` with `GET /health` returning `{ status: "ok", redis: "up" | "down" }`, reused by Tasks 5 through 8.

- [ ] **Step 1: Write the failing test**

```ts
// packages/relay/tests/server.test.ts
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

describe("createServer", () => {
  it("answers the health endpoint without Redis running", async () => {
    const app = createServer({ redisUrl: "redis://127.0.0.1:6399" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", redis: "down" });
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadence/relay`
Expected: FAIL with "Cannot find module '../src/server.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/relay/src/server.ts
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import Redis from "ioredis";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=@cadence/relay`
Expected: 1 passed. Port 6399 must have nothing listening so Redis reports down.

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/server.ts packages/relay/tests/server.test.ts
git commit -m "feat(relay): add server scaffold with health endpoint"
```

### Task 5: Redis room registry with TTL

**Files:**
- Create: `packages/relay/src/rooms.ts`
- Create: `packages/relay/tests/rooms.test.ts`

**Interfaces:**
- Consumes: `createServer` options shape (redisUrl string) from Task 4.
- Produces: `ROOM_TTL_SECONDS = 14400`, `createRoomStore(redisUrl: string): RoomStore` with `createRoom(): Promise<string>`, `roomExists(roomId: string): Promise<boolean>`, `touchRoom(roomId: string): Promise<void>` used by Tasks 6 and 7. Room ids look like `room_` plus 16 lowercase hex characters.

- [ ] **Step 1: Write the failing test**

```ts
// packages/relay/tests/rooms.test.ts
import { afterAll, describe, expect, it } from "vitest";
import Redis from "ioredis";
import { createRoomStore } from "../src/rooms.js";

const redisUrl = "redis://127.0.0.1:6379";

describe("createRoomStore", () => {
  const admin = new Redis(redisUrl);
  afterAll(() => admin.disconnect());

  it("creates rooms that exist with a 4-hour TTL", async () => {
    const store = createRoomStore(redisUrl);
    const roomId = await store.createRoom();
    expect(roomId).toMatch(/^room_[0-9a-f]{16}$/);
    expect(await store.roomExists(roomId)).toBe(true);
    const ttl = await admin.ttl(`cadence:room:${roomId}`);
    expect(ttl).toBeGreaterThan(14000);
    expect(ttl).toBeLessThanOrEqual(14400);
    store.disconnect();
  });

  it("reports unknown rooms as missing", async () => {
    const store = createRoomStore(redisUrl);
    expect(await store.roomExists("room_0000000000000000")).toBe(false);
    store.disconnect();
  });
});
```

Test dependency: start real Redis with `docker run -d -p 6379:6379 redis:7-alpine` before running.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadence/relay`
Expected: FAIL with "Cannot find module '../src/rooms.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/relay/src/rooms.ts
import Redis from "ioredis";
import { randomBytes } from "node:crypto";

export const ROOM_TTL_SECONDS = 14400;

function roomKey(roomId: string): string {
  return `cadence:room:${roomId}`;
}

export interface RoomStore {
  createRoom(): Promise<string>;
  roomExists(roomId: string): Promise<boolean>;
  touchRoom(roomId: string): Promise<void>;
  disconnect(): void;
}

export function createRoomStore(redisUrl: string): RoomStore {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });

  return {
    async createRoom(): Promise<string> {
      const roomId = `room_${randomBytes(8).toString("hex")}`;
      await redis.set(roomKey(roomId), "1", "EX", ROOM_TTL_SECONDS);
      return roomId;
    },

    async roomExists(roomId: string): Promise<boolean> {
      const found = await redis.exists(roomKey(roomId));
      return found === 1;
    },

    async touchRoom(roomId: string): Promise<void> {
      await redis.expire(roomKey(roomId), ROOM_TTL_SECONDS);
    },

    disconnect(): void {
      redis.disconnect();
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `docker run -d -p 6379:6379 redis:7-alpine` (once), then `npm test --workspace=@cadence/relay`
Expected: all relay tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/rooms.ts packages/relay/tests/rooms.test.ts
git commit -m "feat(relay): add Redis room registry with TTL"
```

### Task 6: GitHub OAuth pairing

**Files:**
- Create: `packages/relay/src/auth.ts`
- Create: `packages/relay/tests/auth.test.ts`

**Interfaces:**
- Consumes: `RoomStore` from Task 5.
- Produces: `verifyGitHubUser(accessToken: string, fetchImpl?: typeof fetch): Promise<string>` returning the GitHub login, `pairRoom(store: RoomStore, accessToken: string, fetchImpl?: typeof fetch): Promise<{ room_id: string }>` used by the socket handshake in Task 7. Tests inject a fake fetch; production passes nothing and uses global fetch.

- [ ] **Step 1: Write the failing test**

```ts
// packages/relay/tests/auth.test.ts
import { describe, expect, it } from "vitest";
import { createRoomStore } from "../src/rooms.js";
import { pairRoom, verifyGitHubUser } from "../src/auth.js";

const redisUrl = "redis://127.0.0.1:6379";

function fakeGitHub(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("auth", () => {
  it("returns the GitHub login for a valid token", async () => {
    const fetchImpl = fakeGitHub(200, { login: "octocat" });
    await expect(verifyGitHubUser("valid-token", fetchImpl)).resolves.toBe("octocat");
  });

  it("rejects an invalid token", async () => {
    const fetchImpl = fakeGitHub(401, {});
    await expect(verifyGitHubUser("bad-token", fetchImpl)).rejects.toThrow(
      "GitHub auth failed",
    );
  });

  it("pairs an authenticated user to a fresh room", async () => {
    const fetchImpl = fakeGitHub(200, { login: "octocat" });
    const store = createRoomStore(redisUrl);
    const { room_id } = await pairRoom(store, "valid-token", fetchImpl);
    expect(room_id).toMatch(/^room_[0-9a-f]{16}$/);
    expect(await store.roomExists(room_id)).toBe(true);
    store.disconnect();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadence/relay`
Expected: FAIL with "Cannot find module '../src/auth.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/relay/src/auth.ts
import type { RoomStore } from "./rooms.js";

interface GitHubUserResponse {
  login?: unknown;
}

export async function verifyGitHubUser(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cadence-relay",
    },
  });
  if (!res.ok) {
    throw new Error("GitHub auth failed");
  }
  const body = (await res.json()) as GitHubUserResponse;
  if (typeof body.login !== "string" || body.login.length === 0) {
    throw new Error("GitHub auth failed");
  }
  return body.login;
}

export async function pairRoom(
  store: RoomStore,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ room_id: string }> {
  await verifyGitHubUser(accessToken, fetchImpl);
  const room_id = await store.createRoom();
  return { room_id };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadence/relay`
Expected: all relay tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/auth.ts packages/relay/tests/auth.test.ts
git commit -m "feat(relay): add GitHub OAuth verification and room pairing"
```

### Task 7: WebSocket room routing over pub/sub

**Files:**
- Create: `packages/relay/src/socket.ts`
- Modify: `packages/relay/src/server.ts`
- Create: `packages/relay/tests/socket.test.ts`

**Interfaces:**
- Consumes: `createServer` from Task 4, `createRoomStore` and `touchRoom` from Task 5, `verifyGitHubUser` from Task 6, `EncryptedEnvelopeSchema` from Task 3.
- Produces: `GET /v1/stream?room_id=...&token=...` websocket endpoint plus a `verifyUser` server option for tests. First client message must be untouched relay behavior for later CLI and mobile plans: frames are `EncryptedEnvelope` JSON, validated, published to `cadence:frames:<room_id>`, fanned out to every other socket in the room. Malformed frames are dropped without closing the socket.

- [ ] **Step 1: Write the failing test**

```ts
// packages/relay/tests/socket.test.ts
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { generateSessionKey, encryptEnvelope } from "@cadence/protocol";
import { createServer } from "../src/server.js";
import { createRoomStore } from "../src/rooms.js";

const redisUrl = "redis://127.0.0.1:6379";

function once(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(data.toString()));
    ws.once("error", reject);
  });
}

describe("room routing", () => {
  it("fans an envelope from one member to another and drops malformed frames", async () => {
    const store = createRoomStore(redisUrl);
    const roomId = await store.createRoom();
    store.disconnect();

    const app = createServer({
      redisUrl,
      verifyUser: async () => "test-user",
    });
    await app.listen({ port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const cli = new WebSocket(`ws://127.0.0.1:${port}/v1/stream?room_id=${roomId}&token=t1`);
    const phone = new WebSocket(`ws://127.0.0.1:${port}/v1/stream?room_id=${roomId}&token=t2`);
    await Promise.all([
      new Promise((resolve) => cli.once("open", resolve)),
      new Promise((resolve) => phone.once("open", resolve)),
    ]);

    cli.send("this is not json");
    const key = await generateSessionKey();
    const envelope = await encryptEnvelope(roomId, key, {
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_1" },
      payload: { chunk: "hello phone" },
    });
    const received = once(phone);
    cli.send(JSON.stringify(envelope));
    expect(JSON.parse(await received)).toEqual(envelope);

    cli.close();
    phone.close();
    await app.close();
  }, 15000);
});
```

Build the protocol package first so the `@cadence/protocol` import in this test resolves to `dist`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build --workspace=@cadence/protocol && npm test --workspace=@cadence/relay`
Expected: FAIL with 404 for `/v1/stream` because the route does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/relay/src/socket.ts
import type { FastifyInstance } from "fastify";
import Redis from "ioredis";
import { EncryptedEnvelopeSchema } from "@cadence/protocol";
import { createRoomStore } from "./rooms.js";

export type VerifyUser = (token: string) => Promise<string>;

function framesChannel(roomId: string): string {
  return `cadence:frames:${roomId}`;
}

export function registerStreamRoute(
  app: FastifyInstance,
  redisUrl: string,
  verifyUser: VerifyUser,
): void {
  app.get<{ Querystring: { room_id?: string; token?: string } }>(
    "/v1/stream",
    { websocket: true },
    async (socket, request) => {
      const roomId = request.query.room_id ?? "";
      const token = request.query.token ?? "";
      const store = createRoomStore(redisUrl);
      try {
        await verifyUser(token);
      } catch {
        store.disconnect();
        socket.close(4401, "unauthorized");
        return;
      }
      if (!(await store.roomExists(roomId))) {
        store.disconnect();
        socket.close(4404, "unknown room");
        return;
      }

      const subscriber = new Redis(redisUrl);
      const publisher = new Redis(redisUrl);
      await subscriber.subscribe(framesChannel(roomId));
      subscriber.on("message", (_channel, message) => {
        if (socket.readyState === 1) {
          socket.send(message);
        }
      });

      socket.on("message", async (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          request.log.warn("dropped frame [body redacted]");
          return;
        }
        const envelope = EncryptedEnvelopeSchema.safeParse(parsed);
        if (!envelope.success || envelope.data.room_id !== roomId) {
          request.log.warn("dropped frame [body redacted]");
          return;
        }
        await publisher.publish(framesChannel(roomId), JSON.stringify(envelope.data));
        await store.touchRoom(roomId);
      });

      socket.on("close", () => {
        void subscriber.quit();
        publisher.disconnect();
        store.disconnect();
      });
    },
  );
}
```

The `redactForLog` import comes from Task 8. Task 7 intentionally logs the fixed
string `"dropped frame [body redacted]"` so every step stays green; Task 8
upgrades those two lines to include the room id.

Replace `packages/relay/src/server.ts` with this complete file:

```ts
// packages/relay/src/server.ts
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import Redis from "ioredis";
import { verifyGitHubUser } from "./auth.js";
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

  void app.register(websocket);

  app.get("/health", async () => {
    try {
      await redis.ping();
      return { status: "ok", redis: "up" as const };
    } catch {
      return { status: "ok", redis: "down" as const };
    }
  });

  registerStreamRoute(
    app,
    options.redisUrl,
    options.verifyUser ?? verifyGitHubUser,
  );

  app.addHook("onClose", async () => {
    redis.disconnect();
  });

  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build --workspace=@cadence/protocol && npm test --workspace=@cadence/relay`
Expected: all relay tests pass, including fanout within 15 seconds.

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/socket.ts packages/relay/src/server.ts packages/relay/tests/socket.test.ts
git commit -m "feat(relay): route encrypted envelopes over Redis pub-sub"
```

### Task 8: Log redaction proof

**Files:**
- Create: `packages/relay/src/logging.ts`
- Modify: `packages/relay/src/socket.ts`
- Create: `packages/relay/tests/logging.test.ts`

**Interfaces:**
- Consumes: drop paths in `socket.ts` from Task 7.
- Produces: `redactForLog(value: unknown): string` used for every dropped-frame log line, proving frame bodies never reach logs.

- [ ] **Step 1: Write the failing test**

```ts
// packages/relay/tests/logging.test.ts
import { describe, expect, it } from "vitest";
import { redactForLog } from "../src/logging.js";

describe("redactForLog", () => {
  it("keeps the room id but strips body fields", () => {
    const line = redactForLog({
      room_id: "room_abc",
      iv: "aXZ2",
      ciphertext: "c2VjcmV0",
      chunk: "rm -rf /",
    });
    expect(line).toContain("room_abc");
    expect(line).not.toContain("c2VjcmV0");
    expect(line).not.toContain("rm -rf /");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadence/relay`
Expected: FAIL with "Cannot find module '../src/logging.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/relay/src/logging.ts
export function redactForLog(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "[redacted]";
  }
  const roomId =
    "room_id" in value && typeof value.room_id === "string" ? value.room_id : "unknown";
  return `dropped frame in ${roomId} [body redacted]`;
}
```

In `packages/relay/src/socket.ts`, add the import and upgrade the two fixed
drop log lines from Task 7:

```ts
import { redactForLog } from "./logging.js";

// inside socket.on("message"), replace both fixed strings:
try {
  parsed = JSON.parse(raw.toString());
} catch {
  request.log.warn(redactForLog({ room_id: roomId }));
  return;
}
const envelope = EncryptedEnvelopeSchema.safeParse(parsed);
if (!envelope.success || envelope.data.room_id !== roomId) {
  request.log.warn(redactForLog(parsed));
  return;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadence/relay && npm test --workspace=@cadence/protocol && npm run typecheck`
Expected: everything green; this is the Plan 1 exit gate.

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/logging.ts packages/relay/src/socket.ts packages/relay/tests/logging.test.ts
git commit -m "feat(relay): redact frame bodies from logs"
```
