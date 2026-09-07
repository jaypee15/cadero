# Cadence MVP Design (v0.1)

Date: 2026-09-07 | Status: Draft for review | Approach: A, production-grade, no fallback scaffolding

## 1. Context and goal

Cadence is an open-source, self-hostable remote orchestrator for local AI coding
agents (Claude Code, OpenCode). A local CLI daemon spawns the agent under a
pseudo-terminal, a cloud relay routes frames between the desktop and a mobile
browser, and a mobile PWA renders the terminal and collects approvals. Full
background lives in `docs/prd.md` and `docs/technical-spec.md`.

v0.1 builds the whole loop once, production-grade: npm workspaces plus
TypeScript strict, real Redis, real GitHub OAuth, real agent binaries, real
AES-GCM end-to-end encryption with QR pairing. Deliberately no dev fallbacks
(in-memory rooms, static bypass codes, shell fallbacks, plaintext mode) that
would need cleanup later. First terminal bytes arrive late; that is accepted.

## 2. Scope

In scope for v0.1:

- `packages/protocol`: zod-validated schemas plus shared TypeScript types.
- `packages/cli` (`@cadence/cli`): node-pty spawn of `claude` and `opencode`,
  stdout intercept engine, `.cadencerc` safelist, outbound WSS only,
  encrypt-then-send, terminal QR render.
- `packages/relay` (`@cadence/relay`): Fastify plus websocket plugin, GitHub
  OAuth, Redis room registry with TTL plus pub/sub fanout, zero-retention
  routing.
- `packages/mobile` (`@cadence/mobile`): Next.js App Router SSG plus Tailwind,
  xterm.js plus fit addon, WebCrypto decrypt in memory, prompt input, binary
  approval overlay.
- Root `docker-compose.yml`: relay plus Redis plus static mobile build for
  self-host. `CADENCE_RELAY_URL` overrides the public cloud.

Non-goals: multi-room per user, team sharing, session history or replay,
plaintext transport mode, Windows support (v0.1 targets macOS plus Linux).

## 3. Architecture

npm workspaces monorepo, TypeScript strict, Node 20+. Dependency direction:
`cli`, `relay`, and `mobile` all depend on `protocol`. No cross-dependencies
between the three tiers; the relay never imports CLI or mobile code.

Failure policy is fail fast everywhere: missing agent binary, unreachable
Redis, failed OAuth exchange, or missing AES key all exit or render an
explicit error. No silent degradation.

## 4. Components

### 4.1 Protocol package

Pure types plus validation, no transport code. Schemas:

- `TERMINAL_DATA`: `{ session_id, chunk }`, CLI to mobile.
- `INTERCEPT_REQUIRED`: `{ session_id, agent, reason, command }`, CLI to mobile.
- `RESOLVE_INTERCEPT`: `{ session_id, decision: APPROVE | DENY, input_payload }`,
  mobile to CLI.
- `EXECUTE_AGENT_PROMPT`: `{ session_id, prompt }`, mobile to CLI.
- Encrypted envelope: `{ room_id, iv, ciphertext }`. Only `room_id` travels in
  plaintext so the relay can route.

Every tier validates on receipt with zod and drops malformed frames, logging
the reason with the payload redacted.

### 4.2 CLI daemon

Outbound WSS client only; it never opens a listening socket, so no home-router
configuration is needed. On start it spawns the selected agent under node-pty
(`xterm-256color`, 80x24, `FORCE_COLOR=3`, `CADENCE_ACTIVE=true`, cwd is the
invoking directory). Stdout chunks pass through the intercept engine:

- No prompt signature match: wrap as `TERMINAL_DATA`, encrypt, send.
- Prompt signature match (Claude confirmation text, OpenCode waiting
  markers): pause forwarding of that chunk, emit `INTERCEPT_REQUIRED`.
- Safelist hit (command matches an entry in local `.cadencerc`): write the
  approval directly into the pty and never notify mobile.

Security invariant: the daemon never executes raw shell from the network. The
only writes into the pty are prompt text from `EXECUTE_AGENT_PROMPT` and
approval or denial strings from `RESOLVE_INTERCEPT`. All string handling is
appended input to the existing agent subshell, never a new shell command.

Key generation uses Node WebCrypto AES-GCM 256 per session. The QR encodes
relay URL plus room id plus key and is rendered in the terminal. The key never
leaves the terminal except through the user's own QR scan.

### 4.3 Relay

Fastify plus the websocket plugin, backed by Redis. Flow: GitHub OAuth login
returns a short-lived pairing token, the CLI exchanges it for a `room_id`
stored in Redis with a TTL, and the mobile client joins the same room after
its own OAuth login. Redis pub/sub fans CLI frames out to room members.
The relay parses only the `room_id` header and forwards the ciphertext
untouched. No database, no payload persistence, structured logs redact frame
bodies. Requires a reachable Redis; startup fails loudly otherwise.

### 4.4 Mobile PWA

Next.js App Router statically exported, Tailwind styling, xterm.js plus fit
addon on a terminal canvas. The QR scan seeds room id plus AES key into
in-memory state only, decrypted through WebCrypto. The client emits only the
two mobile-to-CLI intents. `INTERCEPT_REQUIRED` raises a blocking overlay
(Action Required) with approve and deny actions; the terminal view stays
paused behind it until the user decides. The key is never written to
localStorage or IndexedDB.

## 5. Data flow

Pairing: CLI generates the AES key, authenticates via GitHub, receives a
`room_id`, renders the QR. Mobile scans the QR, authenticates via GitHub,
joins the room. Both sides hold the key; the relay holds neither the key nor
any plaintext.

Steady state: agent stdout becomes pty chunks, chunks become encrypted
`TERMINAL_DATA` frames, the relay routes by `room_id`, mobile decrypts and
writes to xterm. Mobile prompt input becomes an encrypted
`EXECUTE_AGENT_PROMPT` frame that the CLI writes into the pty stdin.
Intercept pauses the stream, the overlay collects the decision, and
`RESOLVE_INTERCEPT` resumes or denies the blocked action.

## 6. Error handling

- Relay disconnect: CLI retries with backoff and replays nothing; frames
  produced while offline are dropped and the gap is marked in the mobile feed
  on reconnect. No queue grows unbounded.
- Redis down: relay refuses new room joins with an explicit error and keeps
  existing sockets alive but non-routing until Redis returns.
- PTY exit or agent crash: CLI emits a final `TERMINAL_DATA` frame with the
  exit code and closes the session; the room TTL expires it.
- Intercept with no mobile response: the agent stays paused; a visible
  session timeout of 15 minutes tears the room down with a notice on both ends.
- Malformed or undecryptable frames: dropped with a redacted log line and a
  counter surfaced in relay health output.

## 7. Testing

- Unit: intercept matchers against fixture transcripts for both agents,
  safelist matching, protocol schema accept and reject cases, envelope
  encrypt and decrypt round-trips.
- Contract: CLI plus relay plus a headless mobile test client exercising the
  three events over a real socket against real Redis in CI via compose.
- End to end: scripted session spawning a stub agent that emits a known
  prompt, asserting the overlay decision resumes the stream. Manual pass on a
  phone browser against the compose stack before release.
- No mocked-Redis or mocked-socket suites as permanent fixtures; tests run
  against the real topology.

## 8. Deployment

`docker-compose.yml` stands up the relay, Redis, and the statically built
mobile UI. Self-hosters set `CADENCE_RELAY_URL` to their own domain. Public
cloud onboarding stays as specified: `npx cadence-cli login` on the dev
machine, then scan the terminal QR with the phone to join the session room.

## 9. Open decisions

- Intercept signature list for each agent version needs fixtures gathered from
  real transcripts.
- Session timeout value (currently 15 minutes) is a guess; revisit after dogfooding.
- Room TTL and Redis eviction policy to be pinned during implementation.
