# Cadero Deferred Follow-ups (Backlog)

Maintained: 2026-09-08 | Source: Plans 1-4 final-review triage lists and per-task ledgers (see `docs/superpowers/plans/`).

This file is the durable record of work that was triaged as "ride" during the
four implementation plans and not merged with the MVP. Each item lists the plan
that surfaced it. Nothing here blocks the MVP release except the items marked
**release blocker**.

## Release blockers

- [x] Register the two GitHub OAuth apps and configure the deployment
  (DONE 2026-09-15: production is live at https://cadero.dev on the Contabo
  VPS via Dokploy + Cloudflare; both apps registered and wired):
  - CLI app (device flow, no secret) → `CADERO_GITHUB_CLIENT_ID` for `cadero-cli login`.
  - Relay app (authorization code + client secret) → `GITHUB_OAUTH_CLIENT_ID`,
    `GITHUB_OAUTH_CLIENT_SECRET`, `CADERO_RELAY_PUBLIC_URL`, `CADERO_APP_URL`.
- [ ] Publish `@cadero/cli` to npm. The README quickstart currently documents
  clone + `npm run build` + `npm link ./packages/cli` (verified against a fresh
  clone); switch it to `npm install -g @cadero/cli` once published. (Plan 4)
- [ ] Manual end-to-end pass of the README quickstart on a real phone against
  the compose stack (the one pre-release check flagged as manual-only). (Plan 4)

## Security & hardening

- [ ] Split the OAuth callback's Redis-failure handling from auth failure:
  a session-SET failure after the state DEL currently surfaces 401 (state
  already consumed — user must redo the whole GitHub flow on a transient blip).
  Map Redis failures to 503 `{ error: "relay unavailable" }`. Narrow window,
  self-healing on retry. (Plan 4, Task 2 ledger)
- [ ] Redis-side room readiness for horizontal relay scaling. The Plan 1
  subscribe-readiness gate (`roomMembers` map in `packages/relay/src/socket.ts`)
  is single-process by design; fanout ordering across multiple relay instances
  needs a Redis-based origin/epoch scheme. Documented in-code before any
  scaling work. (Plan 1, Task 7)
- [ ] Replay detection: the relay forwards any validly-shaped encrypted frame;
  a captured frame can be replayed within the room's TTL. Adding a monotonic
  sequence number to `meta` and tracking last-seen per session gives replay
  detection alongside gap tracking. Decide if the threat model warrants it.
  (Plans 3-4 final reviews)

## Testing gaps

- [ ] `onFatal` (wrong-key) close-path contract test on the relay socket layer —
  implemented in both `CaderoSocket` and `MobileSocket` but untested against
  the real relay. (Plan 2/3 tickets; Plan 4 recommendation)
- [ ] DENY-path keystroke test (`"\u001b"` write resumes/cancels correctly) —
  session-level only, untested at the socket layer. (Plan 2, Task 9 ledger)
- [ ] `room_id`-mismatch routing test — an envelope addressed to a different
  room must be dropped (core routing-integrity rule, Plan 1 socket behavior,
  still no dedicated test). (Plan 1, Task 7 ledger)
- [ ] Camera-scan E2E path: the Playwright suite pairs via manual paste; cover
  the `getUserMedia` + jsQR path with a faked camera stream. (Plan 3 final review)
- [ ] Staleness soak test under the compose topology: the 45s force-reconnect
  relies on frames flowing through nginx's 1h `proxy_read_timeout`; half-open
  TCP detection through the proxy is untested. A suspended-relay soak would
  close the biggest runtime gap. (Plan 4 final review)
- [ ] E2E CI wiring: `retries: 1` + explicit reporter in
  `packages/mobile/playwright.config.ts`, and a CI job (Redis service +
  `npm run e2e`) so the full-loop test runs on every PR. E2E is currently
  local-only by design. (Plan 4, Task 10/ledger)
- [ ] Real-device PWA validation (iOS Safari PWA install/behavior) beyond the
  headless chromium E2E. (Plan 3 final review)

## Ops / deployment

- [ ] Compose healthchecks on redis and relay (`depends_on` is order-only;
  a cold start where redis lags crash-loops the relay until
  `restart: unless-stopped` recovers it). (Plan 4, Task 7 ledger)
- [ ] Relay runtime image prune: the multi-stage build copies the full
  `node_modules` including devDeps (`typescript`, `vitest`). Add
  `npm prune --omit=dev` or a prod-only reinstall stage. (Plan 4, Task 7 ledger)
- [ ] Add `.git` to root `.dockerignore` (build context currently ships the
  repo history to the daemon). Cosmetic, context-size only. (Plan 4, Task 7 ledger)
- [ ] First `/health` ping after relay boot reports `"redis": "down"`
  (`lazyConnect` first-ping warm-up in `createServer`, pre-existing Plan 1
  behavior). Add a `connect()` warm-up so health is truthful from the first
  call. (Plan 4, Task 7 report)
- [ ] Validate `CADERO_INTERCEPT_TIMEOUT_MS` before pairing/connecting instead
  of after — an invalid value currently wastes a relay connection and a
  pairing payload before exiting 1. (Plan 4, Task 3 ledger)

## Product / UX

- [ ] Phone-native camera pairing: the `cadero://` QR scheme only parses inside
  the PWA's own scanner. Add an https deep-link line under the QR
  (`https://<relay>/#pair=<urlencoded payload>`) that the PWA reads on load
  and auto-imports after GitHub sign-in — native phone cameras would then
  complete pairing in one scan (needs PWA hash handling + OAuth redirect
  preserving the pairing payload). (Session feedback 2026-09-15)
- [ ] xterm `.xterm-rows` overflows over the Send button in narrow/headless
  viewports (verified via `elementFromPoint` during E2E work; Enter-to-submit
  works and is the tested path). Layout pass: `overflow-hidden` on the
  terminal container or a z-order fix. (Plan 4, Task 8)
- [ ] Document `--agent <claude|opencode>` in the README config table (currently
  discoverable via `cadero-cli --help`; defaults to `claude`). (Plan 4, Task 9)

## Test hygiene (cosmetic, batch opportunistically)

- [ ] Protocol schema rejection tests: bad `agent` enum, empty
  `prompt`/`reason` strings, bad `timestamp`. (Plan 1, Task 2 ledger)
- [ ] `redactForLog` branch tests (non-object, missing `room_id`). (Plan 1, Task 8)
- [ ] Envelope: attach `{ cause }` to `EnvelopeError` for diagnostics. (Plan 2, Task 1)
- [ ] Close-code contract tests: add `ws.on("error")` handlers and explicit
  timeouts (a connect-refused race would hang to the suite timeout). (Plan 4, Task 2)
- [ ] Bound the reconnect `readyState` polls in both socket test twins with
  internal deadlines (currently bounded only by the vitest timeout). (Plan 4, Tasks 4-5)
- [ ] Comment the `""` session_id sentinel in `MobileSocket` heartbeat
  (triggers the UUID stamp in `send`). (Plan 4, Task 5 ledger)
- [ ] Remove unused key-helper imports in the socket tests; unstub
  `vi.stubGlobal` in the terminal test; remove the dead `fitRef` in
  `TerminalView` (brief-verbatim). (Plans 3-4 ledgers)
- [ ] Add `@types/qrcode` to mobile devDeps if mobile tests are ever added to
  a typecheck program that resolves the test import. (Plan 3, Task 4 ledger)
- [ ] `npm audit` triage: 7 vulnerabilities (4 moderate, 2 high, 1 critical)
  in the transitive tree after adding next/jsdom. (Plan 3, Task 3 report)

## Done (for reference — carried from earlier ledgers and since implemented)

- Typed `EnvelopeError` + key import/export helpers (Plan 2 Task 1).
- No-echo relay semantics + origin-id wrapper (Plan 1 fix wave).
- Loud relay startup (`REDIS_URL`, reachability probe) (Plan 1 fix wave).
- `POST /v1/pair` endpoint (Plan 2 Task 2).
- 4401/4404 close-code pinning, shaped 503 outage oracles (Plan 4 Task 2).
- 15-minute intercept timeout with deny teardown (Plan 4 Task 3).
- Heartbeat + staleness detection on both sockets (Plan 4 Tasks 4-5).
- Gap-recovery semantics + GAP_MARKER rendered into the feed (Plan 4 Tasks 5 + fix wave).
- `CADERO_GITHUB_CLIENT_ID` env configuration (Plan 4 Task 6).
- OAuth env quartet wiring in `runMain` (Plan 4 Task 7).
- Full-loop browser E2E incl. prompt-input gating on live phase (Plan 4 Task 8 + fix waves).
- Fresh-clone quickstart + shebang (Plan 4 fix waves).
