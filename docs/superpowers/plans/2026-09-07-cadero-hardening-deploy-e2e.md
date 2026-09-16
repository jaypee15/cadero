# Cadero Hardening + Deployment + E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the MVP: docker-compose self-host stack, the full browser E2E loop (pair → terminal → prompt → intercept → resolve), and the hardening tickets carried from Plans 1-3 (intercept timeout, WS heartbeat, relay outage oracles, close-code contract tests, client-id config, README).

**Architecture:** Heartbeat is an application-level wire event (browser WebSocket cannot send ping frames) — both sockets send `HEARTBEAT` every 20s and force-reconnect when nothing arrives for 45s. The intercept timeout (spec §6: 15 minutes) denies the pending command, notifies both ends, and tears the room down. The compose stack is three containers: Redis, the relay (Node), and nginx serving the mobile static export and reverse-proxying `/v1/` (with WebSocket upgrade) to the relay. Playwright drives the built stack end-to-end: a session token is seeded directly into Redis (test data, not a code bypass), a stub `claude` binary is placed on PATH, and the CLI's non-TTY stdout yields the pairing payload.

**Tech Stack:** TypeScript strict, Node 20+, npm workspaces, ioredis (test seeding), Docker + docker-compose + nginx, Playwright (chromium only), vitest.

## Global Constraints

- Node 20 or newer, no exceptions.
- TypeScript strict mode in every package, `tsc --noEmit` must pass (root `npm run typecheck` — root program + mobile program).
- npm workspaces, package names `@cadero/protocol`, `@cadero/relay`, `@cadero/cli`, `@cadero/mobile`.
- Real Redis required; no in-memory fallbacks; no dev bypasses in shipped code (test-seeded tokens live only in test setup code).
- Zero-knowledge: heartbeats are encrypted like every other frame; the relay routes them blind; no plaintext transport mode is introduced.
- Local final veto: PTY writes remain only approval keystrokes and prompt text.
- Never log credentials, tokens, or frame bodies.
- Fail fast: missing `CADERO_GITHUB_CLIENT_ID` blocks `cadero-cli login` with a clear error.
- Existing interfaces (exact names, Plans 1-3): `@cadero/protocol` — `WireEventSchema`, `WireEvent`, `encryptEnvelope`, `decryptEnvelope`, `EnvelopeError`, `generateSessionKey`, `exportSessionKey`, `importSessionKey`, `parsePairingPayload`; `@cadero/relay` — `createServer({ redisUrl, verifyUser?, oauth? })`, `createRoomStore(redisUrl)`, `createVerifyUser(redisUrl)` (callable with `.disconnect()`), `runMain({ env? })` (port default 8787), stream close codes 4401/4404; `@cadero/cli` — `CaderoSocket` opts `{ relayUrl, roomId, token, sessionKey, sessionId, onClose?, onFatal? }`, `AgentSession` opts `{ agent, command, args?, cwd, socket, sessionId, config, autoApproveText?, onError? }` (pending state is `{ prompt, command }`), `runCli(argv, { env?, caderoDir?, cwd?, fetchImpl?, stdout?, stderr? })`; `@cadero/mobile` — `MobileSocket` opts `{ relayUrl, roomId, token, sessionKey, WebSocketImpl?, onEvent, onGap, onClosed, onFatal? }`, reducer `reduceSession` with `GAP`/`EVENT` actions, `initialSessionState`.

---

### Task 1: Protocol HEARTBEAT event

**Files:**
- Modify: `packages/protocol/src/events.ts`
- Test: `packages/protocol/tests/events.test.ts` (append one case)

**Interfaces:**
- Consumes: existing `WireEventSchema` discriminated union.
- Produces (consumed by Tasks 4, 5): `HeartbeatSchema` (exported), type `Heartbeat = { event: "HEARTBEAT"; meta: { session_id: string; timestamp?: number }; payload: Record<string, never> }`, included in `WireEventSchema` and the `WireEvent` union. Encryption behavior unchanged — heartbeats ride the same envelope.

- [ ] **Step 1: Write the failing test**

Append to the describe block in `packages/protocol/tests/events.test.ts`:

```ts
it("accepts a HEARTBEAT event and rejects one with a payload", () => {
  expect(
    WireEventSchema.safeParse({
      event: "HEARTBEAT",
      meta: { session_id: "sess_1" },
      payload: {},
    }).success,
  ).toBe(true);
  expect(
    WireEventSchema.safeParse({
      event: "HEARTBEAT",
      meta: { session_id: "sess_1" },
      payload: { chunk: "nope" },
    }).success,
  ).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadero/protocol`
Expected: FAIL — HEARTBEAT not in the union (second assertion may pass vacuously until the literal exists).

- [ ] **Step 3: Write minimal implementation**

In `packages/protocol/src/events.ts`, add before the union:

```ts
export const HeartbeatSchema = z.object({
  event: z.literal("HEARTBEAT"),
  meta: metaSchema,
  payload: z.object({}).strict(),
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
```

And extend the union array with `HeartbeatSchema`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build --workspace=@cadero/protocol && npm test --workspace=@cadero/protocol && npm run typecheck`
Expected: protocol suite green, typecheck clean (the union widening is additive; existing discriminated-union consumers still compile).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/events.ts packages/protocol/tests/events.test.ts
git commit -m "feat(protocol): add HEARTBEAT wire event"
```

### Task 2: Relay hardening — outage oracles + close-code contract tests

**Files:**
- Modify: `packages/relay/src/server.ts` (shaped 503s)
- Test: `packages/relay/tests/outage.test.ts` (new)
- Test: `packages/relay/tests/socket.test.ts` (append 4401/4404 cases)

**Interfaces:**
- Consumes: `createServer`, `createRoomStore`, `WebSocket` from `ws`.
- Produces: shaped failure contracts for the compose/E2E tier and the public API surface: `/v1/pair` and `/v1/oauth/*` return `503 { error: "relay unavailable" }` when their Redis operations fail (replacing raw Fastify 500s); the stream route's existing 4401 (unauthorized) and 4404 (unknown room) close codes are pinned by contract tests.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/relay/tests/outage.test.ts
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

const deadRedis = "redis://127.0.0.1:6399"; // nothing listens here

describe("shaped failures when redis is unreachable", () => {
  it("pair returns 503 with a shaped body", async () => {
    const app = createServer({ redisUrl: deadRedis, verifyUser: async () => "octocat" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/pair",
      headers: { authorization: "Bearer t" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "relay unavailable" });
    await app.close();
  });

  it("oauth login returns 503 when the state cannot be stored", async () => {
    const app = createServer({
      redisUrl: deadRedis,
      oauth: {
        clientId: "cid",
        clientSecret: "sec",
        publicUrl: "https://relay.example.com",
        appUrl: "https://app.example.com",
      },
    });
    const res = await app.inject({ method: "GET", url: "/v1/oauth/login" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "relay unavailable" });
    await app.close();
  });
});
```

Append to `packages/relay/tests/socket.test.ts` (reuse the file's existing imports/helpers; it already imports `createServer`, `createRoomStore`, and `WebSocket`-style test clients — the exact import style there is `ws` default import):

```ts
describe("close-code contract", () => {
  it("closes with 4401 when verifyUser rejects", async () => {
    const app = createServer({
      redisUrl,
      verifyUser: async () => {
        throw new Error("GitHub auth failed");
      },
    });
    await app.listen({ port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/stream?room_id=room_x&token=t`);
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    const result = await closed;
    expect(result.code).toBe(4401);
    await app.close();
  });

  it("closes with 4404 for an unknown room", async () => {
    const app = createServer({ redisUrl, verifyUser: async () => "octocat" });
    await app.listen({ port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const closed = new Promise<{ code: number }>((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/v1/stream?room_id=room_0000000000000000&token=t`,
      );
      ws.on("close", (code) => resolve({ code }));
    });
    const result = await closed;
    expect(result.code).toBe(4404);
    await app.close();
  });
});
```

Match the file's local conventions for imports (it already has `redisUrl` const and `ws` import; add `AddressInfo` type import if not present).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@cadero/relay`
Expected: FAIL — pair/oauth return 500 (unhandled), close-code tests likely already pass if Plan 1's behavior holds (they pin existing behavior; if they fail, the relay regressed and the fix is in the route, not the test).

- [ ] **Step 3: Write minimal implementation**

In `packages/relay/src/server.ts`, wrap the Redis-touching sections of both routes:

```ts
// /v1/pair: replace the try/finally store block
let room_id: string;
try {
  const store = createRoomStore(options.redisUrl);
  try {
    room_id = await store.createRoom();
  } finally {
    store.disconnect();
  }
} catch {
  return reply.code(503).send({ error: "relay unavailable" });
}
return { room_id };
```

```ts
// /v1/oauth/login: wrap the state SET
try {
  await oauthRedis.set(`cadero:oauth:state:${state}`, "1", "EX", OAUTH_STATE_TTL_SECONDS);
} catch {
  return reply.code(503).send({ error: "relay unavailable" });
}
```

```ts
// /v1/oauth/callback: extend the existing try to also cover the state DEL,
// mapping Redis failures to 503 while keeping auth failures at 401
let login: string;
try {
  const deleted = await oauthRedis.del(`cadero:oauth:state:${state}`);
  if (deleted !== 1) {
    return reply.code(400).send({ error: "invalid state" });
  }
  const githubToken = await exchangeOAuthCode(options.oauth, code);
  login = await verifyGitHubUser(githubToken, options.oauth.fetchImpl);
} catch {
  // exchange/verify failures are auth failures; a redis failure lands here too
  // and is acceptable as 401 only if we can distinguish. Distinguish explicitly:
}
```

To distinguish precisely, check the error type: wrap only the `del` call in its own try/catch mapping to 503, and keep exchange/verify in the existing 401 catch:

```ts
let deleted: number;
try {
  deleted = await oauthRedis.del(`cadero:oauth:state:${state}`);
} catch {
  return reply.code(503).send({ error: "relay unavailable" });
}
if (deleted !== 1) {
  return reply.code(400).send({ error: "invalid state" });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build --workspace=@cadero/relay && npm test --workspace=@cadero/relay && npm run typecheck`
Expected: all relay suites green, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/server.ts packages/relay/tests/outage.test.ts packages/relay/tests/socket.test.ts
git commit -m "feat(relay): shape redis-outage responses and pin close codes"
```

### Task 3: CLI intercept timeout

**Files:**
- Modify: `packages/cli/src/session.ts`
- Modify: `packages/cli/src/main.ts` (pass the timeout through; stderr note)
- Test: `packages/cli/tests/session.test.ts` (append timeout cases)

**Interfaces:**
- Consumes: `AgentSession` (pending `{ prompt, command }`), `socket.send`, `close` on the CaderoSocket via the injected socket object (main.ts wires shutdown).
- Produces: `export const INTERCEPT_TIMEOUT_MS = 900000;` and `AgentSessionOptions.interceptTimeoutMs?: number` (default `INTERCEPT_TIMEOUT_MS`). On timeout with an intercept still pending: write `"\u001b"` into the PTY (deny), send `TERMINAL_DATA` with chunk `"\n[intercept timed out after 900s; command denied — session ending]\n"` (the seconds value is `interceptTimeoutMs / 1000`, rendered from the actual configured value), then call the injected `socket`'s `close()` **if present** (the FakeSocket in tests lacks it — guard with `typeof this.opts.socket.close === "function"`) and stop the session. The timer is cleared on resolve (APPROVE/DENY) and on stop().

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/tests/session.test.ts`:

```ts
it("denies and tears down when the intercept times out", async () => {
  dir = mkdtempSync(join(tmpdir(), "cadero-sess-"));
  const agent = stubAgent(
    dir,
    'printf "rm -rf ./dist\\nDo you want to proceed? [y/N]"; sleep 5; printf " never"',
  );
  const socket = new FakeSocket();
  (socket as { close?: () => void }).close = vi.fn();
  const session = new AgentSession({
    agent: "claude",
    command: "bash",
    args: [agent],
    cwd: dir,
    socket: socket as never,
    sessionId: "sess_1",
    config: { safeCommands: [] },
    interceptTimeoutMs: 150,
  });
  session.start();
  await socket.all(1); // INTERCEPT_REQUIRED emitted
  const intercept = socket.sent.find((e) => e.event === "INTERCEPT_REQUIRED");
  expect(intercept).toBeDefined();
  // within 2s the timeout fires: notice frame, escape written, socket closed
  await socket.all(2);
  const notice = socket.sent[socket.sent.length - 1];
  expect(notice.event).toBe("TERMINAL_DATA");
  expect((notice.payload as { chunk: string }).chunk).toContain("intercept timed out");
  expect((socket as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
  session.stop();
}, 10000);

it("does not time out an intercept that is resolved in time", async () => {
  dir = mkdtempSync(join(tmpdir(), "cadero-sess-"));
  const agent = stubAgent(
    dir,
    'printf "rm -rf ./dist\\nDo you want to proceed? [y/N]"; read -n 1; printf " continued"',
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
    interceptTimeoutMs: 5000,
  });
  session.start();
  await socket.all(1);
  socket.handler!({
    event: "RESOLVE_INTERCEPT",
    meta: { session_id: "sess_1" },
    payload: { decision: "APPROVE", input_payload: null },
  } as never);
  await socket.all(3);
  expect(socket.sent.some((e) => (e.payload as { chunk?: string }).chunk?.includes("timed out"))).toBe(false);
  session.stop();
}, 10000);
```

Add `import { vi } from "vitest"` to the file's existing vitest import if not present.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadero/cli`
Expected: FAIL — timeout never fires (agent keeps waiting; first test times out at its own 10s guard or fails the close assertion).

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/session.ts`:

```ts
export const INTERCEPT_TIMEOUT_MS = 900000;

// AgentSessionOptions gains:
//   interceptTimeoutMs?: number;

export class AgentSession {
  // new private field:
  private timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  private armInterceptTimeout(): void {
    const ms = this.opts.interceptTimeoutMs ?? INTERCEPT_TIMEOUT_MS;
    this.timeoutTimer = setTimeout(() => {
      void (async () => {
        if (!this.pending) return;
        this.pending = undefined;
        this.pty?.write("\u001b");
        const seconds = Math.round(ms / 1000);
        await this.trySend({
          event: "TERMINAL_DATA",
          meta: { session_id: this.opts.sessionId },
          payload: {
            chunk: `\n[intercept timed out after ${seconds}s; command denied — session ending]\n`,
          },
        });
        const socket = this.opts.socket as { close?: () => void };
        if (typeof socket.close === "function") socket.close();
        this.stop();
      })();
    }, ms);
  }

  private clearInterceptTimeout(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
  }
}
```

Wire it: call `this.armInterceptTimeout()` right after setting `this.pending = hit` in `handleChunk`; call `this.clearInterceptTimeout()` at the top of the RESOLVE branch (after the `if (!this.pending) return;` guard), in `stop()`, and in the timeout callback before sending (via `this.pending = undefined` ordering shown above — call `this.clearInterceptTimeout()` first inside the callback too so re-entry is safe). Use the existing `trySend` helper for the notice frame (it drops on socket failure without crashing).

In `packages/cli/src/main.ts`, pass `interceptTimeoutMs` from an optional env override so operators can shorten it without a rebuild — but default is the spec constant:

```ts
const interceptTimeoutRaw = env.CADERO_INTERCEPT_TIMEOUT_MS;
const interceptTimeoutMs = interceptTimeoutRaw ? Number(interceptTimeoutRaw) : undefined;
// AgentSession opts: interceptTimeoutMs: Number.isFinite(interceptTimeoutMs) ? interceptTimeoutMs : undefined,
```

If `CADERO_INTERCEPT_TIMEOUT_MS` is set but not a positive number, fail loudly at parse time: `err("CADERO_INTERCEPT_TIMEOUT_MS must be a positive integer (milliseconds)")` + exit 1.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadero/cli && npm run typecheck`
Expected: full cli suite green including the two new tests, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/session.ts packages/cli/src/main.ts packages/cli/tests/session.test.ts
git commit -m "feat(cli): add 15-minute intercept timeout with deny teardown"
```

### Task 4: CLI socket heartbeat + staleness detection

**Files:**
- Modify: `packages/cli/src/socket.ts`
- Test: `packages/cli/tests/socket.test.ts` (append heartbeat cases)

**Interfaces:**
- Consumes: `HeartbeatSchema`/`HEARTBEAT` event (Task 1), `CaderoSocket` internals.
- Produces: exported `HEARTBEAT_INTERVAL_MS = 20000;` and `STALE_AFTER_MS = 45000;`. Behavior: while the socket is open, a timer sends a `HEARTBEAT` event (meta.session_id = opts.sessionId) every `HEARTBEAT_INTERVAL_MS`; every received frame (any event) updates `lastReceivedAt = Date.now()`; a second timer (every 5s) force-closes the ws when `Date.now() - lastReceivedAt > STALE_AFTER_MS` (the close triggers the existing reconnect path — and `onGap`-equivalent behavior on the mobile twin). Timers are created on open, cleared on close (user or otherwise). Heartbeat sends go through the existing `send` (encrypted, stamped).

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/tests/socket.test.ts` (the existing contract test's helpers; the relay restart pattern is already proven — the new test asserts staleness triggers a reconnect and a heartbeat arrives end-to-end):

```ts
it("sends heartbeats and reconnects when the peer goes silent", async () => {
  const store = createRoomStore(redisUrl);
  const roomId = await store.createRoom();
  store.disconnect();

  const app = createServer({ redisUrl, verifyUser: async () => "cli" });
  await app.listen({ port: 0 });
  const port = (app.server.address() as AddressInfo).port;
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

  // The relay echoes nothing back to the sender (no-echo), so CLI receives
  // nothing by default; heartbeats flow every HEARTBEAT_INTERVAL_MS and the
  // staleness timer must NOT fire while heartbeats are received.
  // Force staleness by closing the relay without restarting it: the socket
  // should reconnect on its own schedule regardless.
  await app.close();
  // Without a restarted relay, connection attempts fail; the socket keeps
  // retrying. Assert it survives 3 seconds without crashing (heartbeat
  // timers cleared while closed; no unhandled rejections).
  await new Promise((r) => setTimeout(r, 3000));
  const app2 = createServer({ redisUrl, verifyUser: async () => "cli" });
  await app2.listen({ port });
  const back = onceEvent(cli);
  const phone = new CaderoSocket({
    relayUrl,
    roomId,
    token: "t",
    sessionKey,
    sessionId: "sess_phone",
  });
  await phone.connect();
  // A HEARTBEAT from the phone arrives as a decrypted event.
  await phone.send({
    event: "HEARTBEAT",
    meta: { session_id: "sess_phone" },
    payload: {},
  });
  expect(await back).toEqual({
    event: "HEARTBEAT",
    meta: { session_id: "sess_phone" },
    payload: {},
  });

  await cli.close();
  await phone.close();
  await app2.close();
}, 30000);
```

Note for the implementer: this test pins (a) heartbeats traverse the stack as normal events and (b) the socket survives a relay outage window (staleness timers must not throw when closed). The pure staleness→force-close behavior is unit-tested below at the timer level if the contract test proves flaky — keep the timers' logic extractable (`maybeForceReconnect()` private method) so a focused unit test can drive it with injected clocks.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadero/cli`
Expected: FAIL — `HEARTBEAT` send may work (Task 1 widened the schema) but the timers don't exist; the outage-survival leg passes only if the socket already handles closed-socket send throws (it does, per Plan 2 F1). The binding new behavior is the timer wiring; the test failing on the heartbeat-arrival leg is acceptable evidence.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/socket.ts`:

```ts
export const HEARTBEAT_INTERVAL_MS = 20000;
export const STALE_AFTER_MS = 45000;

// CaderoSocket gains private fields:
//   private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
//   private staleTimer: ReturnType<typeof setInterval> | undefined;
//   private lastReceivedAt = Date.now();

// in the ws "open" handler (after reset of backoff):
this.lastReceivedAt = Date.now();
this.heartbeatTimer = setInterval(() => {
  void this.send({
    event: "HEARTBEAT",
    meta: { session_id: this.opts.sessionId },
    payload: {},
  }).catch(() => {
    /* send failure on a dying socket: staleness/close path owns recovery */
  });
}, HEARTBEAT_INTERVAL_MS);
this.staleTimer = setInterval(() => this.maybeForceReconnect(), 5000);

// private maybeForceReconnect(): void {
//   if (this.closedByUser || this.reconnectDisabled) return;
//   const ws = this.ws;
//   if (!ws || ws.readyState !== 1) return;
//   if (Date.now() - this.lastReceivedAt <= STALE_AFTER_MS) return;
//   ws.close(); // handleClose schedules the reconnect with backoff
// }

// in handleRaw, before dispatch:
this.lastReceivedAt = Date.now();

// in handleClose (and close()), clear both timers:
if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
this.heartbeatTimer = undefined;
if (this.staleTimer) clearInterval(this.staleTimer);
this.staleTimer = undefined;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadero/cli && npm run typecheck`
Expected: full cli suite green, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/socket.ts packages/cli/tests/socket.test.ts
git commit -m "feat(cli): heartbeat and staleness detection on relay socket"
```

### Task 5: Mobile socket heartbeat + staleness + gapped semantics

**Files:**
- Modify: `packages/mobile/src/realtime/socket.ts`
- Modify: `packages/mobile/src/state/sessionState.ts` (gapped clearing + gap marker)
- Test: `packages/mobile/tests/socket.test.ts` (append)
- Test: `packages/mobile/tests/sessionState.test.ts` (append)

**Interfaces:**
- Consumes: `HEARTBEAT` event (Task 1), `MobileSocket` internals, reducer.
- Produces: exported `HEARTBEAT_INTERVAL_MS = 20000; STALE_AFTER_MS = 45000;` from the socket module; identical timer semantics to Task 4 (send heartbeat while open; force-close when silent past STALE_AFTER_MS; timers cleared on close; `lastReceivedAt` updated in `handleRaw`). Reducer semantics decision (locked here): `gapped` clears when the next EVENT arrives after a gap (`EVENT` action sets `gapped: false` unconditionally — data flowing again means the banner's job is done; the loss itself is recorded in the terminal feed by Task 9 writing the gap marker text), and the gap marker text constant `GAP_MARKER = "\n[connection lost — output during the gap was not captured]\n"` is exported from sessionState.ts for the app shell.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mobile/tests/socket.test.ts` (mirror of the CLI contract test — HEARTBEAT arrival + outage survival):

```ts
it("sends heartbeats and survives a relay outage window", async () => {
  const store = createRoomStore(redisUrl);
  const roomId = await store.createRoom();
  store.disconnect();

  const app = createServer({ redisUrl, verifyUser: async () => "phone" });
  await app.listen({ port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const relayUrl = `http://127.0.0.1:${port}`;

  const sessionKey = await generateSessionKey();
  const phone = new MobileSocket({
    relayUrl,
    roomId,
    token: "t",
    sessionKey,
    WebSocketImpl: WebSocketImpl as unknown as typeof WebSocket,
    onEvent: () => {},
    onGap: () => {},
    onClosed: () => {},
  });
  await phone.connect();
  await app.close();
  await new Promise((r) => setTimeout(r, 3000));
  const app2 = createServer({ redisUrl, verifyUser: async () => "phone" });
  await app2.listen({ port });
  const back = onceEvent(phone);
  const cli = new MobileSocket({
    relayUrl,
    roomId,
    token: "t",
    sessionKey,
    WebSocketImpl: WebSocketImpl as unknown as typeof WebSocket,
    onEvent: () => {},
    onGap: () => {},
    onClosed: () => {},
  });
  await cli.connect();
  await cli.send({
    event: "HEARTBEAT",
    meta: { session_id: "sess_cli" },
    payload: {},
  });
  expect(await back).toEqual({
    event: "HEARTBEAT",
    meta: { session_id: "sess_cli" },
    payload: {},
  });
  await phone.close();
  await cli.close();
  await app2.close();
}, 30000);
```

Append to `packages/mobile/tests/sessionState.test.ts`:

```ts
it("clears the gap marker when data flows again", () => {
  const gapped = reduceSession(initial, { type: "GAP" });
  expect(gapped.gapped).toBe(true);
  const recovered = reduceSession(gapped, {
    type: "EVENT",
    event: { event: "TERMINAL_DATA", meta: { session_id: "s" }, payload: { chunk: "back" } },
  });
  expect(recovered.gapped).toBe(false);
});

it("exposes the gap marker constant", () => {
  expect(GAP_MARKER).toContain("output during the gap was not captured");
});
```

(Import `GAP_MARKER` in the test file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@cadero/mobile`
Expected: FAIL — heartbeat timers don't exist; `gapped` never clears.

- [ ] **Step 3: Write minimal implementation**

In `packages/mobile/src/realtime/socket.ts`, mirror Task 4 exactly (browser-native WebSocket; `onopen` starts timers, `onclose`/`close()` clears them, `handleRaw` updates `lastReceivedAt`, `maybeForceReconnect()` force-closes a silent-but-open socket so `handleClose` schedules the reconnect — which fires `onGap` on rejoin). Use numeric readyState literals as the module already does.

In `packages/mobile/src/state/sessionState.ts`:

```ts
export const GAP_MARKER = "\n[connection lost — output during the gap was not captured]\n";
```

And in the `EVENT` branch, the `TERMINAL_DATA` case becomes:

```ts
if (event.event === "TERMINAL_DATA") {
  return { ...state, chunkCount: state.chunkCount + 1, gapped: false };
}
```

(The `INTERCEPT_REQUIRED` arm stays as is; it doesn't clear the banner — the feed-level marker in Task 9 covers visibility.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadero/mobile && npm run typecheck`
Expected: full mobile suite green, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/realtime packages/mobile/src/state packages/mobile/tests
git commit -m "feat(mobile): heartbeat, staleness detection, and gap-recovery semantics"
```

### Task 6: CLI GitHub client id from env

**Files:**
- Modify: `packages/cli/src/ghDevice.ts` (client id parameterized)
- Modify: `packages/cli/src/main.ts` (login reads env, fails loud)
- Test: `packages/cli/tests/main.test.ts` (append), `packages/cli/tests/ghDevice.test.ts` (update calls)

**Interfaces:**
- Consumes: `runCli` RunOptions env.
- Produces: `requestDeviceCode(fetchImpl, clientId: string)` and `pollForAccessToken(fetchImpl, deviceCode, opts, clientId: string)` — client id is now an explicit argument (the screaming constant is deleted). `cadero-cli login` requires `CADERO_GITHUB_CLIENT_ID` in the environment: missing or empty → stderr `CADERO_GITHUB_CLIENT_ID is not set; register a GitHub OAuth app and set it to enable login` → exit 1. (Self-host compose passes it through; the public-cloud deployment sets it in the environment of the npm-published CLI via the install channel — that is deployment configuration, not code.)

- [ ] **Step 1: Write the failing tests**

In `packages/cli/tests/ghDevice.test.ts`, update every call: `requestDeviceCode(fetchImpl, "cid-test")` and `pollForAccessToken(fetchImpl, "dev123", { interval, expiresIn, sleep? }, "cid-test")`. In `packages/cli/tests/main.test.ts`, append:

```ts
it("login without CADERO_GITHUB_CLIENT_ID exits 1 with guidance", async () => {
  dir = mkdtempSync(join(tmpdir(), "cadero-main-"));
  const errs: string[] = [];
  const code = await runCli(["login"], {
    caderoDir: dir,
    env: {},
    stderr: (l) => errs.push(l),
  });
  expect(code).toBe(1);
  expect(errs.join("\n")).toContain("CADERO_GITHUB_CLIENT_ID");
});

it("login uses CADERO_GITHUB_CLIENT_ID from env", async () => {
  dir = mkdtempSync(join(tmpdir(), "cadero-main-"));
  const lines: string[] = [];
  const code = await runCli(["login"], {
    caderoDir: dir,
    env: { CADERO_GITHUB_CLIENT_ID: "cid-env" },
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
    stdout: (l) => lines.push(l),
    stderr: (l) => lines.push(l),
  });
  expect(code).toBe(0);
  expect(await (await import("../src/credentials.js")).loadCredentials(dir)).toEqual({
    githubToken: "tok123",
  });
});
```

(The existing happy-path login test must gain `env: { CADERO_GITHUB_CLIENT_ID: "cid-test" }`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@cadero/cli`
Expected: FAIL — signature mismatch on updated calls; env guard missing.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/ghDevice.ts`: delete the `CLIENT_ID` constant; both exported functions take `clientId: string` as their last parameter and send it in the request bodies (`client_id: clientId`). In `packages/cli/src/main.ts`, the `login` branch:

```ts
const clientId = env.CADERO_GITHUB_CLIENT_ID;
if (!clientId) {
  err("CADERO_GITHUB_CLIENT_ID is not set; register a GitHub OAuth app and set it to enable login");
  return 1;
}
const device = await requestDeviceCode(fetchImpl, clientId);
out(`Open ${device.verification_uri} and enter code: ${device.user_code}`);
const token = await pollForAccessToken(fetchImpl, device.device_code, {
  interval: device.interval,
  expiresIn: device.expiresIn,
}, clientId);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadero/cli && npm run typecheck`
Expected: full cli suite green, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/ghDevice.ts packages/cli/src/main.ts packages/cli/tests
git commit -m "feat(cli): configure github client id via CADERO_GITHUB_CLIENT_ID"
```

### Task 7: Relay OAuth env wiring + Dockerfiles + docker-compose + nginx

**Files:**
- Modify: `packages/relay/src/main.ts` (OAuth env wiring)
- Modify: `packages/relay/tests/main.test.ts` (append oauth-wiring case)
- Create: `packages/relay/Dockerfile`
- Create: `packages/mobile/Dockerfile`
- Create: `packages/mobile/nginx.conf`
- Create: `docker-compose.yml`
- Create: `.dockerignore`

**Interfaces:**
- Consumes: `createServer({ redisUrl, verifyUser?, oauth? })` (Plan 3), `runMain({ env? })` (Plan 1).
- Produces: `runMain` gains optional `fetchImpl?: typeof fetch` and reads the OAuth quartet from env — `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `CADERO_RELAY_PUBLIC_URL`, `CADERO_APP_URL`. When all four are set, `oauth` is passed to `createServer` (portal live); when some-but-not-all are set, relay startup fails loudly: `oauth env incomplete: set all of GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, CADERO_RELAY_PUBLIC_URL, CADERO_APP_URL (or none to disable the portal)` with a non-zero exit. When none are set, the portal stays 503 (Plan 3 behavior). The compose stack then works: redis + relay + nginx serving the mobile static export on 8080 and proxying `/v1/*` (WebSocket upgrade) to the relay; operators set the quartet plus `CADERO_RELAY_URL=https://my-private-server.com` on their CLI/phone.

`packages/relay/Dockerfile` (all four package manifests are copied so npm resolves the workspace graph; the install is filtered to protocol+relay so node-pty is never built in this image):

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/relay/package.json packages/relay/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/mobile/package.json packages/mobile/package.json
RUN npm ci --workspace=@cadero/protocol --workspace=@cadero/relay
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/relay packages/relay
RUN npm run build --workspace=@cadero/protocol && npm run build --workspace=@cadero/relay

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/relay/dist ./packages/relay/dist
COPY --from=build /app/packages/relay/package.json ./packages/relay/package.json
CMD ["node", "packages/relay/dist/main.js"]
```

`packages/mobile/Dockerfile`:

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/relay/package.json packages/relay/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/mobile/package.json packages/mobile/package.json
RUN npm ci --workspace=@cadero/protocol --workspace=@cadero/mobile
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/mobile packages/mobile
RUN npm run build --workspace=@cadero/protocol && npm run build --workspace=@cadero/mobile

FROM nginx:1.27-alpine
COPY packages/mobile/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/mobile/out /usr/share/nginx/html
EXPOSE 80
```

`packages/mobile/nginx.conf`:

```nginx
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }

  location /v1/ {
    proxy_pass http://relay:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
  }
}
```

`docker-compose.yml`:

```yaml
services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped

  relay:
    build: packages/relay
    restart: unless-stopped
    environment:
      REDIS_URL: redis://redis:6379
      PORT: "8787"
      GITHUB_OAUTH_CLIENT_ID: ${GITHUB_OAUTH_CLIENT_ID:-}
      GITHUB_OAUTH_CLIENT_SECRET: ${GITHUB_OAUTH_CLIENT_SECRET:-}
      CADERO_RELAY_PUBLIC_URL: ${CADERO_RELAY_PUBLIC_URL:-}
      CADERO_APP_URL: ${CADERO_APP_URL:-}
    depends_on:
      - redis

  web:
    build: packages/mobile
    restart: unless-stopped
    ports:
      - "8080:80"
    depends_on:
      - relay
```

Root `.dockerignore`:

```
node_modules
**/node_modules
.worktrees
.superpowers
docs
*.md
packages/*/dist
packages/*/out
packages/mobile/.next
```

- [ ] **Step 1: Write the failing test for the OAuth env wiring**

Append to `packages/relay/tests/main.test.ts`:

```ts
describe("oauth env wiring", () => {
  it("fails loudly on a partial oauth env", async () => {
    await expect(
      runMain({
        env: {
          REDIS_URL: "redis://127.0.0.1:6379",
          GITHUB_OAUTH_CLIENT_ID: "cid",
        },
      }),
    ).rejects.toThrow("oauth env incomplete");
  });

  it("wires the portal when the full quartet is set", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
    const { app } = await runMain({
      env: {
        REDIS_URL: "redis://127.0.0.1:6379",
        PORT: "0",
        GITHUB_OAUTH_CLIENT_ID: "cid",
        GITHUB_OAUTH_CLIENT_SECRET: "sec",
        CADERO_RELAY_PUBLIC_URL: "https://relay.example.com",
        CADERO_APP_URL: "https://app.example.com",
      },
      fetchImpl,
    });
    const res = await app.inject({ method: "GET", url: "/v1/oauth/login" });
    expect(res.statusCode).toBe(302);
    await app.close();
  });
});
```

Note: `runMain` binds to port 0 here — extend it to honor `PORT=0` (it already does `Number(env.PORT) || 8787`; `0` is falsy, so special-case `env.PORT === "0"` to bind port 0 and report the actual bound port). If that change is unwanted, bind the ephemeral test port explicitly via an existing option — either way the test must not collide with a running relay on 8787.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadero/relay`
Expected: FAIL — runMain has no oauth wiring.

- [ ] **Step 3: Write the implementation**

In `packages/relay/src/main.ts`:

```ts
const oauthValues = {
  clientId: env.GITHUB_OAUTH_CLIENT_ID,
  clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
  publicUrl: env.CADERO_RELAY_PUBLIC_URL,
  appUrl: env.CADERO_APP_URL,
};
const setCount = Object.values(oauthValues).filter((v) => v !== undefined && v !== "").length;
const oauth =
  setCount === 0
    ? undefined
    : setCount === 4
      ? {
          clientId: oauthValues.clientId as string,
          clientSecret: oauthValues.clientSecret as string,
          publicUrl: oauthValues.publicUrl as string,
          appUrl: oauthValues.appUrl as string,
          fetchImpl: options.fetchImpl,
        }
      : (() => {
          throw new Error(
            "oauth env incomplete: set all of GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, CADERO_RELAY_PUBLIC_URL, CADERO_APP_URL (or none to disable the portal)",
          );
        })();

const app = createServer({ redisUrl, oauth });
```

`MainOptions` gains `fetchImpl?: typeof fetch` and passes it through as shown. Handle `PORT=0` for the test (bind ephemeral, return the actual port as today via `app.server.address()`).

- [ ] **Step 4: Write the four infra files** (Dockerfiles, nginx.conf, docker-compose.yml, .dockerignore — contents above).
- [ ] **Step 5: Run tests and verify the stack boots**

Run: `npm run build --workspace=@cadero/relay && npm test --workspace=@cadero/relay && npm run typecheck`
Expected: relay suites green, typecheck clean.

Then: `docker compose build 2>&1 | tail -5 && docker compose up -d && sleep 3 && curl -s http://localhost:8080/health && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/ && docker compose down`
Expected: build succeeds; `/health` proxies through nginx to the relay (`{"status":"ok","redis":"up"}`); the PWA `index.html` serves (200); stack tears down.

- [ ] **Step 6: Commit**

```bash
git add packages/relay/src/main.ts packages/relay/tests/main.test.ts packages/relay/Dockerfile packages/mobile/Dockerfile packages/mobile/nginx.conf docker-compose.yml .dockerignore
git commit -m "feat: wire oauth env into relay startup and add compose stack"
```

### Task 8: Playwright full-loop E2E

**Files:**
- Create: `packages/mobile/playwright.config.ts`
- Create: `packages/mobile/tests/e2e/global-setup.ts`
- Create: `packages/mobile/tests/e2e/static-server.mjs`
- Create: `packages/mobile/tests/e2e/full-loop.spec.ts`
- Modify: `packages/mobile/package.json` (devDeps `@playwright/test`; script `"e2e": "playwright test"`)

**Interfaces:**
- Consumes: relay `runMain`/`createRoomStore`, CLI `runCli`-equivalent via spawned `node packages/cli/dist/main.js`, `ioredis` (devDep, test seeding), the built mobile export.
- Produces: the spec's contract test — the composed system proves pair → live terminal → prompt → intercept → approve → continuation against the real stack (real Redis, real relay process, real CLI process with a stub `claude` on PATH, real browser page).

Setup design (all in `global-setup.ts`, run once per Playwright run):
1. Start a static server for `packages/mobile/out` on `127.0.0.1:4173` (`static-server.mjs`, ~40 lines, SPA fallback to index.html).
2. Start the relay in-process via `runMain({ env: { REDIS_URL: "redis://127.0.0.1:6379", PORT: "8790" } })`.
3. Seed a session token: `redis.set("cadero:session:cadero_e2e...", "e2e-user", "EX", 3600)` with `cadero_` + 32 hex.
4. Create a temp dir with an executable `claude` stub script on PATH (prints `STUB-READY`; reads a line; if the line contains `danger` prints `rm -rf ./dist\nDo you want to proceed? [y/N]` then reads one char and prints `APPROVED-RESULT` on y / `DENIED-RESULT` otherwise; otherwise echoes `ECHO:<line>`).
5. Spawn `node packages/cli/dist/main.js start --agent claude --relay-url http://127.0.0.1:8790` with cwd = a temp project dir (empty), PATH prepended with the stub dir, and `CADERO_GITHUB_CLIENT_ID=unused` (start doesn't need it, but credentials do — write a credentials.json with `{"githubToken":"cadero_e2e..."}` in `CADERO_HOME=~/.cadero`-equivalent temp dir via the CLI's own env: runCli uses `caderoDir` — the spawned CLI uses the real homedir default, so set `HOME=<tempdir>` for the spawn).
6. Capture stdout until the pairing payload line (`/cadero:\/\/pair\?v=1&\S+/` — the CLI prints it raw when stdout is not a TTY).
7. Teardown: kill CLI, close relay app, close static server, delete seeded token.

`static-server.mjs`:

```js
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";

const root = process.argv[2];
const port = Number(process.argv[3]);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let path = join(root, decodeURIComponent(url.pathname));
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    const body = await readFile(join(root, "index.html"));
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  }
}).listen(port, "127.0.0.1", () => console.log(`static on ${port}`));
```

`playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120000,
  globalSetup: "tests/e2e/global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
  },
  workers: 1,
});
```

`full-loop.spec.ts` (the money test):

```ts
import { expect, test } from "@playwright/test";

const E2E_TOKEN = process.env.CADERO_E2E_TOKEN as string;
const PAYLOAD = process.env.CADERO_E2E_PAYLOAD as string;

test("pair, watch terminal, prompt the agent", async ({ page }) => {
  await page.goto(`/?token-not-used#token=${E2E_TOKEN}`);
  await page.getByPlaceholder(/paste the pairing payload/i).fill(PAYLOAD);
  await page.getByRole("button", { name: /pair manually/i }).click();
  await expect(page.locator("pre, .xterm-rows").first()).toContainText("STUB-READY", { timeout: 30000 });
  await page.getByPlaceholder(/prompt the agent/i).fill("say hi");
  await page.getByRole("button", { name: /send/i }).click();
  await expect(page.locator("pre, .xterm-rows").first()).toContainText("ECHO:say hi", { timeout: 30000 });
});

test("intercept overlay approves a dangerous command", async ({ page }) => {
  await page.goto(`/#token=${E2E_TOKEN}`);
  await page.getByPlaceholder(/paste the pairing payload/i).fill(PAYLOAD);
  await page.getByRole("button", { name: /pair manually/i }).click();
  await expect(page.locator("pre, .xterm-rows").first()).toContainText("STUB-READY", { timeout: 30000 });
  await page.getByPlaceholder(/prompt the agent/i).fill("danger");
  await page.getByRole("button", { name: /send/i }).click();
  await expect(page.getByRole("button", { name: /approve/i })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText("rm -rf ./dist")).toBeVisible();
  await page.getByRole("button", { name: /approve/i }).click();
  await expect(page.locator("pre, .xterm-rows").first()).toContainText("APPROVED-RESULT", { timeout: 30000 });
});
```

Both tests share the one CLI session from global setup (the payload + token are per-run env); test 2 relies on the stub's `danger` branch. The stub reads one line per prompt, so the two tests must run serially (`workers: 1` in the config) and in order — Playwright runs files' tests in order within one worker.

Important correction to the stub script (single source of truth, write exactly this):

```bash
#!/bin/bash
printf "STUB-READY\n"
while IFS= read -r line; do
  if [[ "$line" == *"danger"* ]]; then
    printf "rm -rf ./dist\n"
    printf "Do you want to proceed? [y/N]"
    read -r -n 1 answer
    if [[ "$answer" == "y" ]]; then printf "\nAPPROVED-RESULT\n"; else printf "\nDENIED-RESULT\n"; fi
  else
    printf "ECHO:%s\n" "$line"
  fi
done
```

Note on the AgentSession prompt write: `EXECUTE_AGENT_PROMPT` writes `prompt + "\r"`; bash's `read` sees the line without CR issues on Linux/macOS PTYs.

- [ ] **Step 1: Write the four files + package.json changes**

Run `npm install` after adding `@playwright/test` to mobile devDeps, then `npx playwright install chromium`.

- [ ] **Step 2: Verify the suite**

Run: `npm run build --workspace=@cadero/cli && npm run build --workspace=@cadero/mobile && npm run e2e --workspace=@cadero/mobile`
Expected: both tests pass. If the terminal-text assertion needs a different selector (xterm renders into `.xterm-rows` divs with per-character spans — text may be split across spans), relax to a page-level `getByText` with `{ exact: false }` or assert on `page.content()` containing the marker; keep the assertions on user-visible strings (STUB-READY, ECHO:say hi, APPROVED-RESULT).

- [ ] **Step 3: Commit**

```bash
git add packages/mobile/playwright.config.ts packages/mobile/tests/e2e packages/mobile/package.json package-lock.json
git commit -m "feat(mobile): full-loop browser e2e against the real stack"
```

### Task 9: README + LICENSE

**Files:**
- Modify: `README.md` (replace the stub)
- Create: `LICENSE` (MIT)

**Interfaces:**
- Consumes: the finished system's actual commands and env vars.
- Produces: the open-source front door.

README content (write exactly this structure, filling command details from the codebase):

```markdown
# Cadero

Control your local AI coding agents (Claude Code, OpenCode) from your phone.
Cadero runs a daemon next to your agents, routes encrypted frames through a
thin relay, and renders the live terminal in a mobile PWA with approve/deny
controls for every action the agent wants to take.

## Security model

- Zero-knowledge relay: the relay sees only room ids and ciphertext. A
  per-session AES-GCM-256 key is generated on your machine and delivered to
  your phone exclusively via the terminal QR code.
- Local final veto: the daemon never executes shell commands from the
  network. Your phone sends high-level intents; the daemon validates
  everything and only ever feeds your existing agent's stdin.
- Optional safelist: `.caderorc` (`{"safeCommands": ["npm test", ...]}`)
  auto-approves listed commands without bothering your phone.

## Quickstart (self-host)

1. `docker compose up -d` — starts Redis, the relay, and the PWA (port 8080).
2. Set the OAuth env vars for the relay (see Configuration) and restart it.
3. On your dev machine: `npm install -g @cadero/cli`
4. `cadero-cli login` (requires `CADERO_GITHUB_CLIENT_ID` in your env)
5. `cadero-cli start --relay-url http://your-server:8080`
6. Scan the terminal QR with your phone.

## Configuration

| Variable | Where | Purpose |
|---|---|---|
| `CADERO_GITHUB_CLIENT_ID` | CLI env | GitHub OAuth app client id for `cadero-cli login` |
| `CADERO_RELAY_URL` | CLI flag/env | Relay base URL (default: required at start) |
| `CADERO_INTERCEPT_TIMEOUT_MS` | CLI env | Intercept timeout override (default 900000 = 15 min) |
| `REDIS_URL` | relay env | Redis connection string (compose sets it) |
| `PORT` | relay env | Relay listen port (default 8787) |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | relay env | OAuth portal (503 when unset) |
| `CADERO_RELAY_PUBLIC_URL` | relay env | Public base URL for OAuth redirects |
| `CADERO_APP_URL` | relay env | Where the OAuth callback redirects the browser |

## Development

```
npm install
npm run build && npm test && npm run typecheck
npm run e2e --workspace=@cadero/mobile   # full-loop browser test
```

## License

MIT — see [LICENSE](LICENSE).
```

`LICENSE`: the standard MIT text with `Copyright (c) 2026 Cadero contributors`.

- [ ] **Step 1: Write README.md and LICENSE**
- [ ] **Step 2: Commit**

```bash
git add README.md LICENSE
git commit -m "docs: add quickstart readme and MIT license"
```

### Task 10: Exit gate

**Files:**
- Modify: root `package.json` (test script gains the e2e? No — e2e stays an explicit opt-in script; document that)

**Interfaces:**
- Consumes: everything.
- Produces: the final verification.

- [ ] **Step 1: Decide the e2e wiring**

The Playwright suite spawns real processes and needs Docker-free prerequisites (Redis running). Keep it opt-in: root `package.json` gains `"e2e": "npm run e2e --workspace=@cadero/mobile"` and the README development section already lists it as an explicit command. Do NOT chain e2e into `npm test` (CI systems without browsers/Redis would fail).

- [ ] **Step 2: Run the full gate**

Run: `npm run build && npm test && npm run typecheck && npm run e2e --workspace=@cadero/mobile`
Expected: everything green — build (all four packages), 87 unit tests, typecheck (root + mobile programs), and both E2E tests passing.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: expose e2e script at the root"
```
