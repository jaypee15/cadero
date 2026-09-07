# Cadence Mobile PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@cadence/mobile` — the mobile PWA that scans the QR, decrypts the terminal stream in-memory, sends prompts, and drives the approve/deny overlay — plus the relay OAuth portal it authenticates through and the protocol changes it needs.

**Architecture:** Three preparatory changes unblock the browser tier: `@cadence/protocol` goes isomorphic (btoa/atob replaces Buffer; `parsePairingPayload` moves there since `@cadence/cli` pulls node deps), and the relay gains a GitHub OAuth portal issuing short-lived session tokens because GitHub's device/code endpoints are CORS-blocked from browsers. The PWA itself is a statically exported Next.js app: camera QR scan (jsQR), a `MobileSocket` over the browser-native WebSocket (injectable for tests), an xterm.js canvas, a prompt input, and a blocking intercept overlay — all session state lives in memory only.

**Tech Stack:** TypeScript strict, Node 20+, npm workspaces, Next.js (App Router, `output: "export"`), Tailwind CSS, xterm + @xterm/addon-fit, jsQR, vitest. Tests run in Node with injected `fetch`/`WebSocket`; real Redis + real relay for contract tests.

## Global Constraints

- Node 20 or newer, no exceptions.
- TypeScript strict mode in every package, `tsc --noEmit` must pass (root `npm run typecheck`).
- npm workspaces, package names `@cadence/protocol`, `@cadence/relay`, `@cadence/cli`, `@cadence/mobile`.
- Real Redis required; no in-memory fallbacks in implementation or tests.
- Zero-knowledge: the session key lives only in browser memory (`window.crypto.subtle` semantics); never written to localStorage, IndexedDB, cookies, or logs; the OAuth session token likewise memory-only.
- The relay never sees plaintext or AES keys; it routes on the `room_id` header only and never logs frame bodies.
- Mobile emits only `EXECUTE_AGENT_PROMPT` and `RESOLVE_INTERCEPT`; it cannot emit raw shell (spec §4 intent isolation).
- Fail fast: missing OAuth env vars, unreachable relay, bad QR payload, or wrong key all surface explicit errors; no dev bypasses.
- Repo conventions: vitest per package, tsconfig extends ../../tsconfig.base.json, named ioredis import where needed, tests excluded from build include.
- Deferred to Plan 4 (compose + e2e, per the Plan 2 final review tickets): 4401/4404/onFatal/DENY relay contract tests, the 15-minute intercept timeout (spec §6, CLI/relay-side; mobile already renders the resulting closed state), and a WS heartbeat. Mobile displays whatever teardown notices arrive.
- Existing interfaces available (Plans 1-2, exact names): `@cadence/protocol` — `WireEventSchema`, `WireEvent`, `EncryptedEnvelope`, `encryptEnvelope(roomId, key, event)`, `decryptEnvelope(key, envelope)` (throws `EnvelopeError`, reasons `"malformed_envelope" | "decryption_failed" | "invalid_event"`), `generateSessionKey()`, `importSessionKey(raw)`, `exportSessionKey(key)`, `EnvelopeError`; `@cadence/cli` — `parsePairingPayload(payload)` → `{ relay, room, key }` (Task 1 of this plan moves it); `@cadence/relay` — `createServer({ redisUrl, verifyUser? })`, `verifyGitHubUser(token, fetchImpl?)`, `createRoomStore(redisUrl)`, `runMain({ env? })`; stream endpoint `GET /v1/stream?room_id=…&token=…` with close codes 4401/4404; no-echo origin-id semantics (a socket never receives its own frames).

---

### Task 1: Protocol goes isomorphic + parsePairingPayload moves home

**Files:**
- Modify: `packages/protocol/src/envelope.ts` (replace Buffer with btoa/atob)
- Modify: `packages/protocol/src/keys.ts` (replace Buffer with atob/btoa)
- Create: `packages/protocol/src/pairing.ts`
- Modify: `packages/protocol/src/index.ts` (append one export line)
- Modify: `packages/cli/src/pairing.ts` (re-export from protocol, delete local copy)
- Test: `packages/protocol/tests/pairing.test.ts`

**Interfaces:**
- Consumes: existing `exportSessionKey`/`importSessionKey` behavior (unchanged), CLI's `parsePairingPayload` semantics (must match byte-for-byte).
- Produces (consumed by Tasks 4, 5, 9 and the mobile browser bundle): `parsePairingPayload(payload: string): ParsedPairing` and `type ParsedPairing = { relay: string; room: string; key: string }` from `@cadence/protocol`, with key validation: `/^[A-Za-z0-9_-]{43}$/` base64url check that throws `"not a cadence pairing payload"` on mismatch (Plan 2 ticket). CLI keeps exporting the same names (re-exported) so `packages/cli/tests/pairing.test.ts` passes untouched. Protocol has zero Node-only globals afterward (Buffer gone from envelope.ts and keys.ts).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/protocol/tests/pairing.test.ts
import { describe, expect, it } from "vitest";
import { generateSessionKey, exportSessionKey, parsePairingPayload } from "../src/index.js";

describe("parsePairingPayload (protocol)", () => {
  it("parses a payload built from a real session key", async () => {
    const key = await exportSessionKey(await generateSessionKey());
    const payload = `cadence://pair?v=1&relay=${encodeURIComponent("https://relay.example.com")}&room=${encodeURIComponent("room_abc123def4567890")}&key=${key}`;
    const parsed = parsePairingPayload(payload);
    expect(parsed).toEqual({
      relay: "https://relay.example.com",
      room: "room_abc123def4567890",
      key,
    });
  });

  it("rejects a key that is not 43-char base64url", async () => {
    const payload =
      "cadence://pair?v=1&relay=https%3A%2F%2Fr.example.com&room=room_abc123def4567890&key=tooshort";
    expect(() => parsePairingPayload(payload)).toThrow("not a cadence pairing payload");
  });

  it("rejects wrong scheme, host, or version", () => {
    expect(() => parsePairingPayload("https://example.com")).toThrow(
      "not a cadence pairing payload",
    );
    expect(() => parsePairingPayload("cadence://pair?v=2&relay=x&room=y&key=z")).toThrow(
      "not a cadence pairing payload",
    );
  });
});
```

```ts
// packages/protocol/tests/browser-compat.test.ts
import { describe, expect, it } from "vitest";
import {
  decryptEnvelope,
  encryptEnvelope,
  exportSessionKey,
  generateSessionKey,
  importSessionKey,
} from "../src/index.js";

describe("protocol is browser-compatible (no Buffer)", () => {
  it("round-trips using only btoa/atob-backed helpers", async () => {
    const key = await generateSessionKey();
    const raw = await exportSessionKey(key);
    const imported = await importSessionKey(raw);
    const event = {
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_1" },
      payload: { chunk: "unicode ✓ ✓" },
    } as const;
    const env = await encryptEnvelope("room_1", imported, event);
    expect(await decryptEnvelope(imported, env)).toEqual(event);
  });

  it("does not reference Buffer in bundle sources", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const srcDir = join(import.meta.dirname, "..", "src");
    const files = ["envelope.ts", "keys.ts", "pairing.ts"];
    for (const file of files) {
      expect(readFileSync(join(srcDir, file), "utf8")).not.toMatch(/\bBuffer\b/);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@cadence/protocol`
Expected: FAIL — pairing module missing; Buffer still present.

- [ ] **Step 3: Write minimal implementation**

In `packages/protocol/src/envelope.ts` and `packages/protocol/src/keys.ts`, replace every `Buffer` use with isomorphic codecs:

```ts
// top of envelope.ts (replaces toBase64/fromBase64 bodies)
function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(raw: string): Uint8Array {
  const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
```

`keys.ts` drops its Buffer lines and uses `base64UrlToBytes` (import from envelope.ts or a shared `codec.ts` — either is fine, keep one source of truth) plus the same 32-byte length check. `envelope.ts` uses the two helpers for iv/ciphertext and `exportSessionKey` stays byte-identical in output (base64url, 43 chars).

```ts
// packages/protocol/src/pairing.ts
export interface ParsedPairing {
  relay: string;
  room: string;
  key: string;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function parsePairingPayload(payload: string): ParsedPairing {
  let url: URL;
  try {
    url = new URL(payload);
  } catch {
    throw new Error("not a cadence pairing payload");
  }
  if (url.protocol !== "cadence:" || url.hostname !== "pair" || url.searchParams.get("v") !== "1") {
    throw new Error("not a cadence pairing payload");
  }
  const relay = url.searchParams.get("relay");
  const room = url.searchParams.get("room");
  const key = url.searchParams.get("key");
  if (!relay || !room || !key || !KEY_PATTERN.test(key)) {
    throw new Error("not a cadence pairing payload");
  }
  return { relay, room, key };
}
```

Append to `packages/protocol/src/index.ts`:

```ts
export * from "./pairing.js";
```

In `packages/cli/src/pairing.ts`, delete the local `parsePairingPayload`/`ParsedPairing` and replace with:

```ts
export { parsePairingPayload, type ParsedPairing } from "@cadence/protocol";
```

(Keep `pairSession` and the `importSessionKey` re-export exactly as they are.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build --workspace=@cadence/protocol && npm run build --workspace=@cadence/cli && npm test --workspace=@cadence/protocol && npm test --workspace=@cadence/cli && npm run typecheck`
Expected: protocol + cli suites green (CLI's pairing tests still pass via re-export), typecheck clean.

Back-compat note: base64url codecs still decode standard base64 (the `-_`→`+/` replacement is a no-op on strings without `-`/`_`), so frames encrypted with the Plan 1 format remain readable. New frames are written base64url (URL-safe, and the format the QR key already uses).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/envelope.ts packages/protocol/src/keys.ts packages/protocol/src/pairing.ts packages/protocol/src/index.ts packages/protocol/tests/pairing.test.ts packages/protocol/tests/browser-compat.test.ts packages/cli/src/pairing.ts
git commit -m "feat(protocol): browser-safe codecs and pairing payload parsing"
```

### Task 2: Relay GitHub OAuth portal + session tokens

**Files:**
- Modify: `packages/relay/src/auth.ts` (add session store + OAuth exchange)
- Modify: `packages/relay/src/server.ts` (add `/v1/oauth/login`, `/v1/oauth/callback`; default `verifyUser` becomes the composite)
- Test: `packages/relay/tests/oauth.test.ts`

**Interfaces:**
- Consumes: `verifyGitHubUser(token, fetchImpl?)` (Plan 1), `createRoomStore` pattern (Redis conventions), `createServer(options)`.
- Produces (consumed by Tasks 5 and 9): `ServerOptions` gains optional `oauth?: { clientId: string; clientSecret: string; publicUrl: string; appUrl: string; fetchImpl?: typeof fetch }` — when absent, the OAuth routes return 503 `{ error: "oauth not configured" }` and `verifyUser` stays GitHub-PAT-only (back-compat with Plan 1 tests). Routes:
  - `GET /v1/oauth/login` → 302 to `https://github.com/login/oauth/authorize?client_id=<id>&redirect_uri=<publicUrl>/v1/oauth/callback&scope=read:user&state=<16hex>` with the state stored in Redis under `cadence:oauth:state:<state>` (TTL 600s, single-use).
  - `GET /v1/oauth/callback?code&state` → validates+deletes the state (unknown/expired → 400 `{ error: "invalid state" }`), POSTs to `https://github.com/login/oauth/access_token` with `{ client_id, client_secret, code }`, verifies the login, mints `cadence_<32hex>` stored at `cadence:session:<token>` with TTL 43200 (12h), then 302 to `<appUrl>#token=<token>`.
  - Default `verifyUser` becomes `createVerifyUser(redisUrl, fetchImpl?)`: checks `cadence:session:<token>` in Redis first (returns the stored login), falls back to `verifyGitHubUser`.
- `SESSION_TTL_SECONDS = 43200`, `OAUTH_STATE_TTL_SECONDS = 600` exported for tests.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/relay/tests/oauth.test.ts
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { createVerifyUser, SESSION_TTL_SECONDS } from "../src/auth.js";
import type WebSocket from "ws";

const redisUrl = "redis://127.0.0.1:6379";

const OAUTH_ENV = {
  clientId: "cid123",
  clientSecret: "secret456",
  publicUrl: "https://relay.example.com",
  appUrl: "https://app.example.com",
};

function fakeGithubFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(String(init?.body)) as { code: string };
      if (body.code !== "good-code") {
        return new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 200 });
      }
      return new Response(JSON.stringify({ access_token: "gh-token-1" }), { status: 200 });
    }
    if (url === "https://api.github.com/user") {
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth === "Bearer gh-token-1") {
        return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
      }
      return new Response("{}", { status: 401 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

describe("OAuth portal", () => {
  it("login redirects to GitHub authorize with a stored state", async () => {
    const app = createServer({ redisUrl, oauth: { ...OAUTH_ENV, fetchImpl: fakeGithubFetch() } });
    const res = await app.inject({ method: "GET", url: "/v1/oauth/login" });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.host).toBe("github.com");
    expect(location.searchParams.get("client_id")).toBe("cid123");
    expect(location.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
    await app.close();
  });

  it("callback mints a session token and redirects to the app", async () => {
    const app = createServer({ redisUrl, oauth: { ...OAUTH_ENV, fetchImpl: fakeGithubFetch() } });
    const login = await app.inject({ method: "GET", url: "/v1/oauth/login" });
    const state = new URL(login.headers.location as string).searchParams.get("state") as string;

    const res = await app.inject({
      method: "GET",
      url: `/v1/oauth/callback?code=good-code&state=${state}`,
    });
    expect(res.statusCode).toBe(302);
    const target = new URL(res.headers.location as string);
    expect(target.origin + target.pathname).toBe("https://app.example.com/");
    const token = target.hash.replace("#token=", "");
    expect(token).toMatch(/^cadence_[0-9a-f]{32}$/);

    // The session token authenticates the stream handshake like a PAT would.
    const verify = createVerifyUser(redisUrl, fakeGithubFetch());
    expect(await verify(token)).toBe("octocat");
    await app.close();
  });

  it("rejects an unknown state with 400", async () => {
    const app = createServer({ redisUrl, oauth: { ...OAUTH_ENV, fetchImpl: fakeGithubFetch() } });
    const res = await app.inject({
      method: "GET",
      url: "/v1/oauth/callback?code=good-code&state=00000000000000000000000000000000",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid state" });
    await app.close();
  });

  it("session tokens honor the 12h TTL", async () => {
    expect(SESSION_TTL_SECONDS).toBe(43200);
  });

  it("returns 503 when oauth is not configured", async () => {
    const app = createServer({ redisUrl });
    const res = await app.inject({ method: "GET", url: "/v1/oauth/login" });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

// Type-only import keeps the ws devDependency honest in this file.
export type { WebSocket };
```

Remove the stray `export type { WebSocket }` if linting objects; it exists only to keep the import used.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@cadence/relay`
Expected: FAIL — 404 on the new routes, missing `createVerifyUser`.

- [ ] **Step 3: Write minimal implementation**

In `packages/relay/src/auth.ts`, append:

```ts
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";

export const SESSION_TTL_SECONDS = 43200;
export const OAUTH_STATE_TTL_SECONDS = 600;

function sessionKey(token: string): string {
  return `cadence:session:${token}`;
}

export type { VerifyUser } from "./socket.js";

export function createVerifyUser(redisUrl: string, fetchImpl?: typeof fetch) {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  return async (token: string): Promise<string> => {
    try {
      const login = await redis.get(sessionKey(token));
      if (login) return login;
    } finally {
      // keep the connection for the process lifetime; disconnected by server onClose
    }
    return verifyGitHubUser(token, fetchImpl);
  };
}

export function sessionTokenKey(token: string): string {
  return sessionKey(token);
}

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  appUrl: string;
  fetchImpl?: typeof fetch;
}

export async function exchangeOAuthCode(
  config: OAuthConfig,
  code: string,
): Promise<string> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const res = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "cadence-relay",
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
    }),
  });
  const body = (await res.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new Error("oauth code exchange failed");
  }
  return body.access_token;
}
```

In `packages/relay/src/server.ts`, extend `ServerOptions` with `oauth?: OAuthConfig` and add before the `onClose` hook:

```ts
const oauthRedis = new Redis(options.redisUrl, { maxRetriesPerRequest: 3 });

app.get("/v1/oauth/login", async (_request, reply) => {
  if (!options.oauth) {
    return reply.code(503).send({ error: "oauth not configured" });
  }
  const state = randomBytes(16).toString("hex");
  await oauthRedis.set(`cadence:oauth:state:${state}`, "1", "EX", OAUTH_STATE_TTL_SECONDS);
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", options.oauth.clientId);
  authorize.searchParams.set("redirect_uri", `${options.oauth.publicUrl}/v1/oauth/callback`);
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);
  return reply.redirect(authorize.toString());
});

app.get<{ Querystring: { code?: string; state?: string } }>(
  "/v1/oauth/callback",
  async (request, reply) => {
    if (!options.oauth) {
      return reply.code(503).send({ error: "oauth not configured" });
    }
    const { code, state } = request.query;
    if (!code || !state) {
      return reply.code(400).send({ error: "invalid state" });
    }
    const deleted = await oauthRedis.del(`cadence:oauth:state:${state}`);
    if (deleted !== 1) {
      return reply.code(400).send({ error: "invalid state" });
    }
    try {
      const githubToken = await exchangeOAuthCode(options.oauth, code);
      const login = await verifyGitHubUser(githubToken, options.oauth.fetchImpl);
      const token = `cadence_${randomBytes(16).toString("hex")}`;
      await oauthRedis.set(`cadence:session:${token}`, login, "EX", SESSION_TTL_SECONDS);
      const target = new URL(options.oauth.appUrl);
      target.hash = `token=${token}`;
      return reply.redirect(target.toString());
    } catch {
      return reply.code(401).send({ error: "oauth exchange failed" });
    }
  },
);
```

And change the default verifyUser wiring so both the stream route and `/v1/pair` use the composite when no explicit `verifyUser` was injected:

```ts
const defaultVerify = createVerifyUser(options.redisUrl);
// registerStreamRoute(app, options.redisUrl, options.verifyUser ?? defaultVerify);
// /v1/pair: (options.verifyUser ?? defaultVerify)(token)
```

Keep `options.verifyUser ?? …` semantics identical for existing tests. Add `oauthRedis.disconnect()` to the `onClose` hook. `createVerifyUser` opens its own Redis connection for the process lifetime — store the connection (have `createVerifyUser` return `{ verify, disconnect }`, or accept an injected `Redis` instance) and disconnect it in `onClose` too; a leaked connection per server instance is a real bug under compose restarts. Import `randomBytes`, `exchangeOAuthCode`, `SESSION_TTL_SECONDS`, `OAUTH_STATE_TTL_SECONDS`, `createVerifyUser` from `./auth.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build --workspace=@cadence/relay && npm test --workspace=@cadence/relay && npm test --workspace=@cadence/cli && npm run typecheck`
Expected: all relay tests green (Plan 1-2 suites still pass — `verifyUser` injection unchanged), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/auth.ts packages/relay/src/server.ts packages/relay/tests/oauth.test.ts
git commit -m "feat(relay): add github oauth portal with session tokens"
```

### Task 3: Mobile package scaffold

**Files:**
- Create: `packages/mobile/package.json`
- Create: `packages/mobile/tsconfig.json`
- Create: `packages/mobile/next.config.mjs`
- Create: `packages/mobile/postcss.config.mjs`
- Create: `packages/mobile/src/app/globals.css`
- Create: `packages/mobile/src/app/layout.tsx`
- Create: `packages/mobile/src/app/page.tsx`
- Modify: root `package.json` build script (append mobile build? No — see Step 3)
- Test: `packages/mobile/tests/smoke.test.tsx`

**Interfaces:**
- Consumes: nothing yet.
- Produces: `@cadence/mobile` building a static export (`out/`) with Tailwind, plus `renderApp()`-free smoke test proving the suite runs. Root build script stays protocol+relay+cli only (Next has its own build; the exit-gate task wires the full chain).

- [ ] **Step 1: Write manifests and configs**

`packages/mobile/package.json`:

```json
{
  "name": "@cadence/mobile",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3100",
    "build": "next build",
    "test": "vitest run"
  },
  "dependencies": {
    "@cadence/protocol": "0.1.0",
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/xterm": "^5.5.0",
    "jsqr": "^1.4.0",
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.1.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^25.0.1",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/postcss": "^4.0.0",
    "vitest": "^2.1.0"
  }
}
```

Note on Tailwind 4: no `tailwind.config.js` needed; PostCSS plugin plus a CSS import is the whole setup.

`packages/mobile/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "noEmit": true,
    "allowJs": false,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "moduleDetection": "force"
  },
  "include": ["src", "next.config.mjs", "vitest.config.ts"]
}
```

`packages/mobile/next.config.mjs`:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
```

`packages/mobile/postcss.config.mjs`:

```js
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
```

`packages/mobile/src/app/globals.css`:

```css
@import "tailwindcss";
```

`packages/mobile/src/app/layout.tsx`:

```tsx
import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Cadence", viewport: "width=device-width, initial-scale=1" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-900 text-slate-100 min-h-dvh">{children}</body>
    </html>
  );
}
```

`packages/mobile/src/app/page.tsx`:

```tsx
export default function Home() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <p className="text-slate-400">Cadence mobile — pairing UI lands in Task 9.</p>
    </main>
  );
}
```

- [ ] **Step 2: Wire the vitest environment and a smoke test**

`packages/mobile/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.tsx", "tests/**/*.test.ts"],
  },
});
```

```tsx
// packages/mobile/tests/smoke.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "../src/app/page.js";

describe("mobile scaffold", () => {
  it("renders the placeholder shell", () => {
    render(<Home />);
    expect(screen.getByText(/Cadence mobile/)).toBeDefined();
  });
});
```

- [ ] **Step 3: Install and verify**

Run: `npm install && npm test --workspace=@cadence/mobile && npm run build --workspace=@cadence/mobile && npm run typecheck`
Expected: install succeeds, smoke test passes, static export builds to `packages/mobile/out/`, typecheck clean. Root build script is unchanged in this task.

- [ ] **Step 4: Commit**

```bash
git add packages/mobile package-lock.json
git commit -m "chore(mobile): scaffold next.js static-export pwa with tailwind and vitest"
```

### Task 4: QR scan + paste import

**Files:**
- Create: `packages/mobile/src/pairing/scanQr.ts`
- Create: `packages/mobile/src/pairing/camera.ts`
- Modify: `packages/mobile/package.json` (devDep: `jsqr` types come bundled)
- Test: `packages/mobile/tests/scanQr.test.ts`

**Interfaces:**
- Consumes: `parsePairingPayload` from `@cadence/protocol` (Task 1).
- Produces (consumed by Task 9): `decodeQrFromImageData(imageData: ImageData): ParsedPairing` — runs jsQR, throws `Error("no QR code found")` on miss, `parsePairingPayload` errors bubble verbatim; `createCameraScanner(): { start(onFrame: (imageData: ImageData) => void): Promise<void>; stop(): void }` — `getUserMedia` rear camera loop at video element size, 250ms sampling, `stop()` releases the track. (The UI renders the video element itself; the scanner only owns the stream + loop.)

- [ ] **Step 1: Write the failing test**

Generate a QR bitmap with the `qrcode` package (CLI devDep already has it; add `qrcode` to mobile devDeps) and feed jsQR the raw module matrix as ImageData:

```ts
// packages/mobile/tests/scanQr.test.ts
import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { decodeQrFromImageData } from "../src/pairing/scanQr.js";
import { parsePairingPayload } from "@cadence/protocol";

async function qrImageData(payload: string): Promise<ImageData> {
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dark = qr.modules.data[y * size + x];
      const v = dark ? 0 : 255;
      const i = (y * size + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: size, height: size } as ImageData;
}

const PAYLOAD =
  "cadence://pair?v=1&relay=https%3A%2F%2Frelay.example.com&room=room_abc123def4567890&key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("decodeQrFromImageData", () => {
  it("decodes a generated pairing QR into a parsed payload", async () => {
    const image = await qrImageData(PAYLOAD);
    const parsed = decodeQrFromImageData(image);
    expect(parsed.room).toBe("room_abc123def4567890");
    expect(parsed.relay).toBe("https://relay.example.com");
  });

  it("throws when no QR is present", () => {
    const blank = new ImageData(200, 200);
    expect(() => decodeQrFromImageData(blank)).toThrow("no QR code found");
  });

  it("surfaces parsePairingPayload errors verbatim", async () => {
    const image = await qrImageData("https://example.com/not-cadence");
    expect(() => decodeQrFromImageData(image)).toThrow("not a cadence pairing payload");
  });
});

describe("parsePairingPayload integration", () => {
  it("round-trips through parse", async () => {
    const image = await qrImageData(PAYLOAD);
    const text = (() => {
      // decodeQr returns ParsedPairing already; assert the contract holds
      const parsed = decodeQrFromImageData(image);
      return parsePairingPayload(
        `cadence://pair?v=1&relay=${encodeURIComponent(parsed.relay)}&room=${encodeURIComponent(parsed.room)}&key=${parsed.key}`,
      );
    })();
    expect(text).toEqual(decodeQrFromImageData(image));
  });
});
```

`new ImageData(200, 200)` requires jsdom canvas support — if jsdom lacks it, build the blank via the same manual constructor (`{ data: new Uint8ClampedArray(200*200*4).fill(255), width: 200, height: 200 }`). Prefer the manual form everywhere; jsdom's ImageData constructor is unreliable.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@cadence/mobile`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

`packages/mobile/src/pairing/scanQr.ts`:

```ts
import jsQR from "jsqr";
import { parsePairingPayload, type ParsedPairing } from "@cadence/protocol";

export function decodeQrFromImageData(imageData: ImageData): ParsedPairing {
  const result = jsQR(imageData.data, imageData.width, imageData.height);
  if (!result || !result.data) {
    throw new Error("no QR code found");
  }
  return parsePairingPayload(result.data);
}
```

`packages/mobile/src/pairing/camera.ts`:

```ts
export interface CameraScanner {
  start(onFrame: (imageData: ImageData) => void): Promise<void>;
  stop(): void;
}

export function createCameraScanner(video: HTMLVideoElement): CameraScanner {
  let stream: MediaStream | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  return {
    async start(onFrame) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      video.srcObject = stream;
      await video.play();
      timer = setInterval(() => {
        if (!ctx || video.videoWidth === 0) return;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        onFrame(ctx.getImageData(0, 0, canvas.width, canvas.height));
      }, 250);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      stream?.getTracks().forEach((track) => track.stop());
      stream = undefined;
    },
  };
}
```

Add `qrcode` to mobile devDependencies (test-only QR generation).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadence/mobile && npm run typecheck`
Expected: scan tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/pairing packages/mobile/tests/scanQr.test.ts packages/mobile/package.json package-lock.json
git commit -m "feat(mobile): qr camera scan and pairing payload import"
```

### Task 5: MobileSocket — browser websocket with gap tracking

**Files:**
- Create: `packages/mobile/src/realtime/socket.ts`
- Test: `packages/mobile/tests/socket.test.ts`

**Interfaces:**
- Consumes: `encryptEnvelope`, `decryptEnvelope`, `EnvelopeError`, `EncryptedEnvelope`, `WireEvent` from `@cadence/protocol`; relay `createServer`/`createRoomStore` for contract tests; close codes 4401/4404.
- Produces (consumed by Tasks 6, 8, 9): `class MobileSocket` with:
  - `constructor(opts: { relayUrl: string; roomId: string; token: string; sessionKey: CryptoKey; WebSocketImpl?: typeof WebSocket; onEvent(e: WireEvent): void; onGap(): void; onClosed(code: number, reason: string): void; onFatal?(e: EnvelopeError): void })` — `WebSocketImpl` defaults to `globalThis.WebSocket`.
  - `connect(): Promise<void>`, `close(): Promise<void>`, `send(event: WireEvent): Promise<void>` (stamps `meta.session_id`/`timestamp` if absent — same semantics as the CLI socket; throws when not open; no offline queue).
  - Reconnect with backoff 1s→30s cap, reset on open; on every reconnect-after-drop, `onGap()` fires once so the UI can mark the feed (spec §6: offline frames are dropped, gap marked).
  - 4401/4404 → no reconnect, `onClosed` surfaces the code; `decryption_failed` → `onFatal`, reconnect disabled, socket closed.
  - Tests use the `ws` package as `WebSocketImpl` (add `ws` + `@types/ws` to mobile devDeps) against the real relay + real Redis.

- [ ] **Step 1: Write the failing contract test**

```ts
// packages/mobile/tests/socket.test.ts
import { describe, expect, it } from "vitest";
import WebSocketImpl from "ws";
import {
  exportSessionKey,
  generateSessionKey,
  importSessionKey,
} from "@cadence/protocol";
import { createServer } from "@cadence/relay/server.js";
import { createRoomStore } from "@cadence/relay/rooms.js";
import { MobileSocket } from "../src/realtime/socket.js";

const redisUrl = "redis://127.0.0.1:6379";

function onceEvent(socket: MobileSocket): Promise<unknown> {
  return new Promise((resolve) => {
    const prev = socket.onEvent;
    socket.onEvent = (event) => {
      prev(event);
      resolve(event);
    };
  });
}

describe("MobileSocket against the real relay", () => {
  it("sends and receives decrypted events, marks gaps on reconnect", async () => {
    const store = createRoomStore(redisUrl);
    const roomId = await store.createRoom();
    store.disconnect();

    const app = createServer({ redisUrl, verifyUser: async () => "phone" });
    await app.listen({ port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const relayUrl = `http://127.0.0.1:${port}`;

    const sessionKey = await generateSessionKey();
    let gaps = 0;
    const phone = new MobileSocket({
      relayUrl,
      roomId,
      token: "t",
      sessionKey,
      WebSocketImpl: WebSocketImpl as unknown as typeof WebSocket,
      onEvent: () => {},
      onGap: () => {
        gaps += 1;
      },
      onClosed: () => {},
    });
    const opened = phone.connect();
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
    await Promise.all([opened, cli.connect()]);

    const received = onceEvent(phone);
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

    // Drop the relay, bring it back on the same port: the phone reconnects
    // and onGap fired exactly once for the lost window.
    await app.close();
    const app2 = createServer({ redisUrl, verifyUser: async () => "phone" });
    await app2.listen({ port });
    const back = onceEvent(phone);
    await new Promise((r) => setTimeout(r, 2500));
    await cli.send({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_cli" },
      payload: { chunk: "after gap" },
    });
    expect(await back).toEqual({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_cli" },
      payload: { chunk: "after gap" },
    });
    expect(gaps).toBe(1);

    await phone.close();
    await cli.close();
    await app2.close();
  }, 30000);
});
```

`onEvent` reassignment works because it is a plain property; if the implementation prefers a private handler registry, adapt the test helper to `setHandler` — but keep the public shape from this interface block (property assignment is the simplest). The implementer may instead collect events via an array handler from the start; the contract under test is the same.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build --workspace=@cadence/relay && npm test --workspace=@cadence/mobile`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/mobile/src/realtime/socket.ts
import {
  decryptEnvelope,
  encryptEnvelope,
  EnvelopeError,
  type EncryptedEnvelope,
  type WireEvent,
} from "@cadence/protocol";

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

export interface MobileSocketOptions {
  relayUrl: string;
  roomId: string;
  token: string;
  sessionKey: CryptoKey;
  WebSocketImpl?: typeof WebSocket;
  onEvent(event: WireEvent): void;
  onGap(): void;
  onClosed(code: number, reason: string): void;
  onFatal?(error: EnvelopeError): void;
}

export class MobileSocket {
  private opts: MobileSocketOptions;
  private ws: WebSocket | undefined;
  private backoffMs = BASE_BACKOFF_MS;
  private closedByUser = false;
  private reconnectDisabled = false;
  private hasConnectedOnce = false;
  private connecting: Promise<void> | undefined;

  constructor(opts: MobileSocketOptions) {
    this.opts = opts;
  }

  // Rebindable handler for tests; production passes onEvent in opts.
  onEvent(event: WireEvent): void {
    this.opts.onEvent(event);
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
      const WS = this.opts.WebSocketImpl ?? globalThis.WebSocket;
      const ws = new WS(this.streamUrl());
      this.ws = ws;
      ws.onopen = () => {
        settled = true;
        if (this.hasConnectedOnce) this.opts.onGap();
        this.hasConnectedOnce = true;
        this.backoffMs = BASE_BACKOFF_MS;
        resolve();
      };
      ws.onmessage = (message) => this.handleRaw(String(message.data));
      ws.onclose = (event) => this.handleClose(event.code, event.reason);
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("relay connection failed"));
        }
      };
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
      return; // transport garbage: drop
    }
    void decryptEnvelope(this.opts.sessionKey, envelope as EncryptedEnvelope)
      .then((event) => this.onEvent(event))
      .catch((err: unknown) => {
        if (err instanceof EnvelopeError && err.reason === "decryption_failed") {
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
      this.opts.onClosed(code, reason);
      return;
    }
    if (this.closedByUser || this.reconnectDisabled) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    setTimeout(() => {
      if (this.closedByUser || this.reconnectDisabled) return;
      void this.connect().catch(() => {
        /* close handler already scheduled the next retry */
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
        session_id: event.meta.session_id || crypto.randomUUID(),
        timestamp: event.meta.timestamp ?? Math.floor(Date.now() / 1000),
      },
    };
    const envelope = await encryptEnvelope(this.opts.roomId, this.opts.sessionKey, stamped);
    ws.send(JSON.stringify(envelope));
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.addEventListener("close", () => resolve(), { once: true });
      ws.close();
    });
  }
}
```

Note: browser `WebSocket` uses `readyState` constants on the constructor (`.OPEN === 1`, `.CLOSED === 3`) — the `ws` test double exposes the same constants; if the injected impl lacks them, compare against the numeric literals `1` and `3` instead. Prefer the literals to be double-safe: `ws.readyState !== 1`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build --workspace=@cadence/relay && npm test --workspace=@cadence/mobile && npm run typecheck`
Expected: contract test green (send/receive + reconnect gap), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/realtime packages/mobile/tests/socket.test.ts packages/mobile/package.json package-lock.json
git commit -m "feat(mobile): encrypted websocket client with gap tracking"
```

### Task 6: Terminal canvas

**Files:**
- Create: `packages/mobile/src/components/TerminalView.tsx`
- Test: `packages/mobile/tests/terminal.test.tsx`

**Interfaces:**
- Consumes: `WireEvent` type; `@xterm/xterm` + `@xterm/addon-fit`.
- Produces (consumed by Task 9): `TerminalView({ eventsRef }: { eventsRef: { current: WireEvent[] } })` — no; simpler and testable: `createTerminalView()` is over-engineering. Use the React component with an imperative handle:
  - `TerminalView` forwards a ref API via props: `onReady(api: { write(chunk: string): void; fit(): void; dispose(): void })` — parent owns the lifecycle; component owns xterm instance, canvas sizing (ResizeObserver + FitAddon), and the slate-900 theme (`background: "#0f172a"`, cursorBlink, `allowProposedApi: true`).
  - Client-only: `"use client"` directive + dynamic `import("@xterm/xterm")` inside `useEffect` so the static export never evaluates xterm on the server.
- jsdom cannot run real xterm/canvas — the test asserts the wrapper contract with a stubbed xterm module (`vi.mock`), which is acceptable here because the real rendering is exercised in Plan 4's browser E2E.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/mobile/tests/terminal.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { TerminalView } from "../src/components/TerminalView.js";

const write = vi.fn();
const fit = vi.fn();
const dispose = vi.fn();

vi.mock("@xterm/xterm", () => {
  class Terminal {
    onLoad = undefined as unknown as () => void;
    constructor(_opts: unknown) {}
    write(chunk: string) {
      write(chunk);
    }
    loadAddon() {}
    open() {}
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {
      fit();
    }
    dispose() {
      dispose();
    }
  },
}));

describe("TerminalView", () => {
  it("hands the parent a write/fit/dispose api once mounted", async () => {
    let api: { write(chunk: string): void } | undefined;
    render(<TerminalView onReady={(a) => (api = a)} />);
    // useEffect runs synchronously in jsdom with React 19 + testing-library act
    await vi.waitFor(() => expect(api).toBeDefined());
    api!.write("hello");
    expect(write).toHaveBeenCalledWith("hello");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadence/mobile`
Expected: FAIL — component missing.

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/mobile/src/components/TerminalView.tsx
"use client";

import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

export interface TerminalApi {
  write(chunk: string): void;
  fit(): void;
  dispose(): void;
}

export function TerminalView({ onReady }: { onReady(api: TerminalApi): void }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon: Fit }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !hostRef.current) return;
      const term = new XTerm({
        cursorBlink: true,
        allowProposedApi: true,
        theme: { background: "#0f172a" },
      });
      const fitAddon = new Fit();
      term.loadAddon(fitAddon);
      term.open(hostRef.current);
      termRef.current = term;
      fitRef.current = fitAddon;
      const refit = () => fitAddon.fit();
      observer = new ResizeObserver(refit);
      observer.observe(hostRef.current);
      onReady({
        write: (chunk) => term.write(chunk),
        fit: () => fitAddon.fit(),
        dispose: () => {
          observer?.disconnect();
          term.dispose();
        },
      });
    })();
    return () => {
      disposed = true;
      observer?.disconnect();
      termRef.current?.dispose();
    };
  }, [onReady]);

  return <div ref={hostRef} className="h-full w-full" />;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadence/mobile && npm run typecheck`
Expected: terminal test passes with the stubbed modules, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/components packages/mobile/tests/terminal.test.tsx
git commit -m "feat(mobile): xterm terminal canvas component"
```

### Task 7: Session state machine (reducer)

**Files:**
- Create: `packages/mobile/src/state/sessionState.ts`
- Test: `packages/mobile/tests/sessionState.test.ts`

**Interfaces:**
- Consumes: `WireEvent` from `@cadence/protocol`.
- Produces (consumed by Task 9): `type SessionPhase = "need-pairing" | "connecting" | "live" | "closed"`; `type InterceptState = { id: string; agent: string; command: string }`; `interface SessionState { phase: SessionPhase; intercept: InterceptState | null; gapped: boolean; chunkCount: number }`; `type SessionAction = { type: "PAIR_SCANNED" } | { type: "CONNECTED" } | { type: "EVENT"; event: WireEvent } | { type: "GAP" } | { type: "RESOLVED" } | { type: "CLOSED"; code: number; reason: string } | { type: "FATAL"; message: string }`; `reduceSession(state: SessionState, action: SessionAction): SessionState` with semantics:
  - `EVENT TERMINAL_DATA` → `chunkCount += 1`
  - `EVENT INTERCEPT_REQUIRED` → sets `intercept { id: meta.session_id + ":" + timestamp, agent, command }`
  - `EVENT RESOLVE_INTERCEPT` / `EXECUTE_AGENT_PROMPT` → ignored (mobile never receives those)
  - `RESOLVED` → clears `intercept`
  - `GAP` → `gapped = true`
  - `CONNECTED` after a gap → `gapped = false` is the *socket's* job via ordering: reducer just records; Task 9 sends `GAP` on reconnect-before-open and nothing clears it automatically (the gap banner stays until the next event arrives — spec §6 "gap is marked in the feed").
  - `CLOSED` → `phase = "closed"` (with code/reason surfaced via a separate `closedReason` field — add `closedReason?: string` to `SessionState`)
  - `FATAL` → `phase = "closed"`, `closedReason = message`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/mobile/tests/sessionState.test.ts
import { describe, expect, it } from "vitest";
import { reduceSession, type SessionState } from "../src/state/sessionState.js";

const initial: SessionState = {
  phase: "connecting",
  intercept: null,
  gapped: false,
  chunkCount: 0,
};

describe("reduceSession", () => {
  it("counts terminal chunks", () => {
    const next = reduceSession(initial, {
      type: "EVENT",
      event: { event: "TERMINAL_DATA", meta: { session_id: "s" }, payload: { chunk: "x" } },
    });
    expect(next.chunkCount).toBe(1);
  });

  it("raises an intercept and clears it on resolve", () => {
    const raised = reduceSession(initial, {
      type: "EVENT",
      event: {
        event: "INTERCEPT_REQUIRED",
        meta: { session_id: "sess_1", timestamp: 42 },
        payload: { agent: "claude", reason: "EXECUTE_COMMAND", command: "rm -rf ./dist" },
      },
    });
    expect(raised.intercept).toEqual({
      id: "sess_1:42",
      agent: "claude",
      command: "rm -rf ./dist",
    });
    expect(reduceSession(raised, { type: "RESOLVED" }).intercept).toBeNull();
  });

  it("ignores mobile-direction events", () => {
    const next = reduceSession(initial, {
      type: "EVENT",
      event: {
        event: "RESOLVE_INTERCEPT",
        meta: { session_id: "s" },
        payload: { decision: "APPROVE", input_payload: null },
      },
    });
    expect(next).toEqual(initial);
  });

  it("marks gaps and closes on close/fatal", () => {
    expect(reduceSession(initial, { type: "GAP" }).gapped).toBe(true);
    const closed = reduceSession(initial, { type: "CLOSED", code: 4404, reason: "unknown room" });
    expect(closed.phase).toBe("closed");
    expect(closed.closedReason).toContain("4404");
    const fatal = reduceSession(initial, { type: "FATAL", message: "wrong key" });
    expect(fatal.phase).toBe("closed");
    expect(fatal.closedReason).toContain("wrong key");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadence/mobile`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/mobile/src/state/sessionState.ts
import type { WireEvent } from "@cadence/protocol";

export type SessionPhase = "need-pairing" | "connecting" | "live" | "closed";

export interface InterceptState {
  id: string;
  agent: string;
  command: string;
}

export interface SessionState {
  phase: SessionPhase;
  intercept: InterceptState | null;
  gapped: boolean;
  chunkCount: number;
  closedReason?: string;
}

export type SessionAction =
  | { type: "PAIR_SCANNED" }
  | { type: "CONNECTED" }
  | { type: "EVENT"; event: WireEvent }
  | { type: "GAP" }
  | { type: "RESOLVED" }
  | { type: "CLOSED"; code: number; reason: string }
  | { type: "FATAL"; message: string };

export const initialSessionState: SessionState = {
  phase: "need-pairing",
  intercept: null,
  gapped: false,
  chunkCount: 0,
};

export function reduceSession(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "PAIR_SCANNED":
      return { ...state, phase: "connecting" };
    case "CONNECTED":
      return { ...state, phase: "live" };
    case "GAP":
      return { ...state, gapped: true };
    case "RESOLVED":
      return { ...state, intercept: null };
    case "CLOSED":
      return {
        ...state,
        phase: "closed",
        closedReason: `relay closed the session (${action.code} ${action.reason})`,
      };
    case "FATAL":
      return { ...state, phase: "closed", closedReason: action.message };
    case "EVENT": {
      const event = action.event;
      if (event.event === "TERMINAL_DATA") {
        return { ...state, chunkCount: state.chunkCount + 1 };
      }
      if (event.event === "INTERCEPT_REQUIRED") {
        return {
          ...state,
          intercept: {
            id: `${event.meta.session_id}:${event.meta.timestamp ?? 0}`,
            agent: event.payload.agent,
            command: event.payload.command,
          },
        };
      }
      return state; // mobile-direction events never arrive here
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadence/mobile && npm run typecheck`
Expected: reducer tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/state packages/mobile/tests/sessionState.test.ts
git commit -m "feat(mobile): session state machine"
```

### Task 8: Intercept overlay + prompt input + gap banner components

**Files:**
- Create: `packages/mobile/src/components/InterceptOverlay.tsx`
- Create: `packages/mobile/src/components/PromptInput.tsx`
- Create: `packages/mobile/src/components/GapBanner.tsx`
- Test: `packages/mobile/tests/components.test.tsx`

**Interfaces:**
- Consumes: `InterceptState` from Task 7.
- Produces (consumed by Task 9):
  - `InterceptOverlay({ intercept, busy, onDecision }: { intercept: InterceptState; busy: boolean; onDecision(decision: "APPROVE" | "DENY"): void })` — full-screen fixed overlay (z-50), red-tinted for DENY-adjacent framing, big APPROVE (green) and DENY (red) buttons, both disabled while `busy`, `command` shown in a mono block.
  - `PromptInput({ disabled, onSend(prompt: string): void })` — bottom-docked input + send button; disabled while an intercept is pending; trims and ignores empty prompts.
  - `GapBanner({ visible }: { visible: boolean })` — amber banner "Connection lost — output during the gap was not captured", rendered only when visible.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/mobile/tests/components.test.tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { InterceptOverlay } from "../src/components/InterceptOverlay.js";
import { PromptInput } from "../src/components/PromptInput.js";
import { GapBanner } from "../src/components/GapBanner.js";

describe("InterceptOverlay", () => {
  it("shows the command and disables buttons while busy", () => {
    const onDecision = vi.fn();
    render(
      <InterceptOverlay
        intercept={{ id: "i", agent: "claude", command: "rm -rf ./dist" }}
        busy
        onDecision={onDecision}
      />,
    );
    expect(screen.getByText("rm -rf ./dist")).toBeDefined();
    const approve = screen.getByRole("button", { name: /approve/i });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("emits APPROVE and DENY", () => {
    const onDecision = vi.fn();
    render(
      <InterceptOverlay
        intercept={{ id: "i", agent: "claude", command: "npm test" }}
        busy={false}
        onDecision={onDecision}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(onDecision).toHaveBeenNthCalledWith(1, "APPROVE");
    expect(onDecision).toHaveBeenNthCalledWith(2, "DENY");
  });
});

describe("PromptInput", () => {
  it("sends trimmed prompts and ignores empties", () => {
    const onSend = vi.fn();
    render(<PromptInput disabled={false} onSend={onSend} />);
    const input = screen.getByPlaceholderText(/prompt/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  list the src dir  " } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).toHaveBeenCalledWith("list the src dir");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("disables input while an intercept is pending", () => {
    render(<PromptInput disabled onSend={() => {}} />);
    expect((screen.getByPlaceholderText(/prompt/i) as HTMLInputElement).disabled).toBe(true);
  });
});

describe("GapBanner", () => {
  it("renders only when visible", () => {
    const { rerender } = render(<GapBanner visible={false} />);
    expect(screen.queryByText(/Connection lost/)).toBeNull();
    rerender(<GapBanner visible />);
    expect(screen.getByText(/Connection lost/)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadence/mobile`
Expected: FAIL — components missing.

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/mobile/src/components/InterceptOverlay.tsx
"use client";

import type { InterceptState } from "../state/sessionState.js";

export function InterceptOverlay({
  intercept,
  busy,
  onDecision,
}: {
  intercept: InterceptState;
  busy: boolean;
  onDecision(decision: "APPROVE" | "DENY"): void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-slate-950/80 p-4 pb-8">
      <div className="w-full rounded-2xl bg-slate-800 p-5 shadow-2xl">
        <p className="text-sm font-semibold uppercase tracking-wide text-amber-400">
          Action required — {intercept.agent}
        </p>
        <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-slate-950 p-3 font-mono text-sm text-slate-100">
          {intercept.command}
        </pre>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision("APPROVE")}
            className="rounded-xl bg-emerald-600 px-4 py-4 text-base font-semibold text-white disabled:opacity-40"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision("DENY")}
            className="rounded-xl bg-rose-600 px-4 py-4 text-base font-semibold text-white disabled:opacity-40"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
```

```tsx
// packages/mobile/src/components/PromptInput.tsx
"use client";

import { useState } from "react";

export function PromptInput({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend(prompt: string): void;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    onSend(trimmed);
    setValue("");
  };
  return (
    <div className="flex items-center gap-2 border-t border-slate-700 bg-slate-800 p-3">
      <input
        type="text"
        placeholder="Prompt the agent…"
        disabled={disabled}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
        className="min-w-0 flex-1 rounded-xl bg-slate-950 px-4 py-3 text-base text-slate-100 disabled:opacity-40"
      />
      <button
        type="button"
        disabled={disabled}
        onClick={submit}
        className="rounded-xl bg-sky-600 px-4 py-3 font-semibold text-white disabled:opacity-40"
      >
        Send
      </button>
    </div>
  );
}
```

```tsx
// packages/mobile/src/components/GapBanner.tsx
"use client";

export function GapBanner({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="bg-amber-500 px-4 py-2 text-center text-sm font-medium text-amber-950">
      Connection lost — output during the gap was not captured
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@cadence/mobile && npm run typecheck`
Expected: component tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/components packages/mobile/tests/components.test.tsx
git commit -m "feat(mobile): intercept overlay, prompt input, gap banner"
```

### Task 9: App shell wiring

**Files:**
- Create: `packages/mobile/src/app/CadenceApp.tsx`
- Create: `packages/mobile/src/app/oauth.ts`
- Modify: `packages/mobile/src/app/page.tsx` (mount CadenceApp, client boundary)
- Test: `packages/mobile/tests/appFlow.test.tsx`

**Interfaces:**
- Consumes: everything above — `decodeQrFromImageData`, `createCameraScanner` (Task 4), `MobileSocket` (Task 5), `TerminalView` (Task 6), reducer + components (Tasks 7-8), `importSessionKey` from `@cadence/protocol`.
- Produces: the complete PWA flow.
  - `packages/mobile/src/app/oauth.ts`: `readOAuthTokenFromHash(): string | null` — parses `#token=cadence_…` from `location.hash` and strips the hash (history.replaceState); `loginUrl(relay: string): string` → `${relay}/v1/oauth/login`.
  - `CadenceApp` (the only stateful client component): phases per the reducer; QR screen renders a `<video>` + scanner + a manual-paste textarea (same `parsePairingPayload` path); after a successful scan: `importSessionKey(key)`, build `MobileSocket`, connect, wire callbacks into the reducer; TERMINAL_DATA → terminal api write; INTERCEPT_REQUIRED → overlay; overlay decision → `RESOLVE_INTERCEPT { decision, input_payload: null }` via socket, then `RESOLVED`; prompt send → `EXECUTE_AGENT_PROMPT { prompt }`; onClosed/onFatal → closed screen with reason.
  - Security: session key and OAuth token held only in `useRef`/closure memory; nothing persisted; no `console.log` of decrypted events (log nothing).
  - `page.tsx` becomes `"use client"` + dynamic import of `CadenceApp` (`ssr: false` via `next/dynamic`) so the static export ships a hydratable shell.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/mobile/tests/appFlow.test.tsx
import { describe, expect, it } from "vitest";
import { readOAuthTokenFromHash } from "../src/app/oauth.js";

describe("readOAuthTokenFromHash", () => {
  it("extracts and strips the token hash", () => {
    window.location.hash = "#token=cadence_abc";
    expect(readOAuthTokenFromHash()).toBe("cadence_abc");
    expect(window.location.hash).toBe("");
    expect(readOAuthTokenFromHash()).toBeNull();
  });
});
```

(The full component flow — scan → connect → overlay — is exercised in Plan 4's browser E2E against the compose stack; this task's automated coverage is the hash reader plus the suites from Tasks 4-8. The implementer additionally does a manual dev-server walkthrough and records it in the report: `npm run dev` in mobile + real relay, paste a real QR payload into the manual field, see the shell go live with a local CLI session.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@cadence/mobile`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/mobile/src/app/oauth.ts
export function readOAuthTokenFromHash(): string | null {
  const hash = window.location.hash;
  const match = hash.match(/^#token=([A-Za-z0-9_]+)$/);
  if (!match) return null;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return match[1];
}

export function loginUrl(relay: string): string {
  return `${relay}/v1/oauth/login`;
}
```

`CadenceApp` (condensed but complete; the implementer writes it out fully):

```tsx
// packages/mobile/src/app/CadenceApp.tsx
"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { importSessionKey, parsePairingPayload } from "@cadence/protocol";
import {
  initialSessionState,
  reduceSession,
  type InterceptState,
} from "./state/sessionState.js";
import { decodeQrFromImageData } from "./pairing/scanQr.js";
import { createCameraScanner } from "./pairing/camera.js";
import { MobileSocket } from "./realtime/socket.js";
import { TerminalView, type TerminalApi } from "./components/TerminalView.js";
import { InterceptOverlay } from "./components/InterceptOverlay.js";
import { PromptInput } from "./components/PromptInput.js";
import { GapBanner } from "./components/GapBanner.js";
import { readOAuthTokenFromHash, loginUrl } from "./oauth.js";

export function CadenceApp() {
  const [state, dispatch] = useReducer(reduceSession, initialSessionState);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const socketRef = useRef<MobileSocket | null>(null);
  const termRef = useRef<TerminalApi | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [manualPayload, setManualPayload] = useState("");
  const [scanning, setScanning] = useState(false);

  // Stable identity: an inline arrow here would re-run TerminalView's
  // effect on every dispatch and tear the xterm instance down repeatedly.
  const handleTerminalReady = useCallback((api: TerminalApi) => {
    termRef.current = api;
  }, []);

  const startSession = useCallback(
    async (parsed: { relay: string; room: string; key: string }) => {
      try {
        const sessionKey = await importSessionKey(parsed.key);
        const token = readOAuthTokenFromHash();
        if (!token) {
          setError(`No session token. Open ${loginUrl(parsed.relay)} to sign in with GitHub first.`);
          return;
        }
        dispatch({ type: "PAIR_SCANNED" });
        const socket = new MobileSocket({
          relayUrl: parsed.relay,
          roomId: parsed.room,
          token,
          sessionKey,
          onEvent: (event) => {
            if (event.event === "TERMINAL_DATA") {
              termRef.current?.write(event.payload.chunk);
            }
            dispatch({ type: "EVENT", event });
          },
          onGap: () => dispatch({ type: "GAP" }),
          onClosed: (code, reason) => dispatch({ type: "CLOSED", code, reason }),
          onFatal: (err) =>
            dispatch({
              type: "FATAL",
              message: "Session key rejected — pairing mismatch. Rescan the QR.",
            }),
        });
        socketRef.current = socket;
        await socket.connect();
        dispatch({ type: "CONNECTED" });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  const scanViaCamera = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    setScanning(true);
    const scanner = createCameraScanner(video);
    try {
      await scanner.start((imageData) => {
        try {
          const parsed = decodeQrFromImageData(imageData);
          scanner.stop();
          setScanning(false);
          void startSession(parsed);
        } catch {
          /* frame without a readable QR: keep scanning */
        }
      });
    } catch (err) {
      setScanning(false);
      setError(err instanceof Error ? err.message : "camera unavailable");
    }
  }, [startSession]);

  const importManual = useCallback(() => {
    try {
      void startSession(parsePairingPayload(manualPayload.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "invalid pairing payload");
    }
  }, [manualPayload, startSession]);

  const decide = useCallback(
    async (decision: "APPROVE" | "DENY") => {
      const socket = socketRef.current;
      if (!socket || !state.intercept) return;
      setResolving(true);
      try {
        await socket.send({
          event: "RESOLVE_INTERCEPT",
          meta: { session_id: state.intercept.id.split(":")[0] ?? "sess" },
          payload: { decision, input_payload: null },
        });
        dispatch({ type: "RESOLVED" });
      } finally {
        setResolving(false);
      }
    },
    [state.intercept],
  );

  const sendPrompt = useCallback(async (prompt: string) => {
    const socket = socketRef.current;
    if (!socket) return;
    try {
      await socket.send({
        event: "EXECUTE_AGENT_PROMPT",
        meta: { session_id: "mobile" },
        payload: { prompt },
      });
    } catch {
      dispatch({ type: "GAP" });
    }
  }, []);

  useEffect(() => {
    return () => {
      socketRef.current?.close();
    };
  }, []);

  if (state.phase === "closed") {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-lg font-semibold">Session closed</p>
        <p className="text-sm text-slate-400">{state.closedReason ?? "The session ended."}</p>
      </main>
    );
  }

  if (state.phase === "need-pairing") {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-6 p-6">
        <h1 className="text-xl font-semibold">Pair with your desktop</h1>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <video ref={videoRef} className="h-64 w-64 rounded-2xl bg-slate-800" muted playsInline />
        <button
          type="button"
          onClick={() => void scanViaCamera()}
          disabled={scanning}
          className="rounded-xl bg-sky-600 px-6 py-3 font-semibold text-white disabled:opacity-40"
        >
          {scanning ? "Scanning…" : "Scan QR code"}
        </button>
        <div className="w-full max-w-sm">
          <textarea
            value={manualPayload}
            onChange={(event) => setManualPayload(event.target.value)}
            placeholder="…or paste the pairing payload"
            className="h-20 w-full rounded-xl bg-slate-950 p-3 font-mono text-xs text-slate-300"
          />
          <button
            type="button"
            onClick={importManual}
            className="mt-2 w-full rounded-xl bg-slate-700 px-4 py-2 text-sm font-medium text-slate-100"
          >
            Pair manually
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-dvh flex-col bg-slate-900">
      <GapBanner visible={state.gapped} />
      <div className="relative min-h-0 flex-1">
        <TerminalView onReady={handleTerminalReady} />
        {state.intercept && (
          <InterceptOverlay intercept={state.intercept} busy={resolving} onDecision={(d) => void decide(d)} />
        )}
      </div>
      <PromptInput disabled={state.intercept !== null} onSend={(p) => void sendPrompt(p)} />
    </main>
  );
}
```

```tsx
// packages/mobile/src/app/page.tsx
"use client";

import dynamic from "next/dynamic";

const CadenceApp = dynamic(() => import("./CadenceApp.js").then((m) => m.CadenceApp), {
  ssr: false,
  loading: () => <main className="p-6 text-slate-400">Loading…</main>,
});

export default function Home() {
  return <CadenceApp />;
}
```

Implementation notes (binding):
- `meta.session_id` on `RESOLVE_INTERCEPT` must match the CLI session id embedded in the intercept id (`intercept.id.split(":")[0]`).
- The `onFatal` reducer message must not echo exception internals (no key material anywhere in UI strings).
- Nothing logs; no `console.*` calls anywhere in `src/`.

- [ ] **Step 4: Run tests and the dev-server walkthrough**

Run: `npm run build --workspace=@cadence/mobile && npm test --workspace=@cadence/mobile && npm run typecheck`
Expected: static export builds, hash-reader test passes, typecheck clean. Manual walkthrough recorded in the report (real relay + real CLI session + pasted payload → live terminal).

- [ ] **Step 5: Commit**

```bash
git add packages/mobile/src/app packages/mobile/tests/appFlow.test.tsx
git commit -m "feat(mobile): wire pairing, terminal, prompt and overlay into the app shell"
```

### Task 10: Exit gate — root build chain + full verification

**Files:**
- Modify: root `package.json` (build script gains mobile, test script gains mobile)
- Test: full-suite run (no new files)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: one-command verification for the whole monorepo.

- [ ] **Step 1: Update root scripts**

Root `package.json`:

```json
"build": "npm run build --workspace=@cadence/protocol && npm run build --workspace=@cadence/relay && npm run build --workspace=@cadence/cli && npm run build --workspace=@cadence/mobile",
"test": "npm test --workspace=@cadence/protocol && npm test --workspace=@cadence/relay && npm test --workspace=@cadence/cli && npm test --workspace=@cadence/mobile"
```

- [ ] **Step 2: Run the gate**

Run: `npm run build && npm test && npm run typecheck`
Expected: everything green — cli, protocol, relay, mobile suites; static export present in `packages/mobile/out/`; `tsc --noEmit` clean across workspaces.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: wire mobile into root build and test chain"
```
