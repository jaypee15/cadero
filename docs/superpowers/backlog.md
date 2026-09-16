# Cadero Deferred Follow-ups (Backlog)

Maintained: 2026-09-16 | Source: Plans 1-4 final-review triage lists, per-task
ledgers, and the 2026-09-16 UX redesign (see
`docs/superpowers/specs/2026-09-16-ux-redesign-design.md`).

This file is the durable record of work that was triaged as "ride" during the
four implementation plans and not merged with the MVP. Each item lists the plan
that surfaced it. Nothing here blocks the MVP release except the items marked
**release blocker**.

## Release blockers

- [x] Register the two GitHub OAuth apps and configure the deployment
  (DONE 2026-09-15: production is live at https://cadero.dev on the Contabo
  VPS via Dokploy + Cloudflare; both apps registered and wired):
  - CLI app (device flow, no secret) → `CADERO_GITHUB_CLIENT_ID` for `cadero login`.
  - Relay app (authorization code + client secret) → `GITHUB_OAUTH_CLIENT_ID`,
    `GITHUB_OAUTH_CLIENT_SECRET`, `CADERO_RELAY_PUBLIC_URL`, `CADERO_APP_URL`.
- [ ] Publish `@cadero/cli` to npm. The README quickstart currently documents
  clone + `npm run build` + `npm link ./packages/cli` (verified against a fresh
  clone); switch it to `npm install -g @cadero/cli` once published. (Plan 4)
- [ ] Manual end-to-end pass of the README quickstart on a real phone against
  the compose stack (the one pre-release check flagged as manual-only). (Plan 4)

## Security & hardening

- [x] Split the OAuth callback's Redis-failure handling from auth failure:
  the session-SET failure after the state DEL now surfaces 503
  `{ error: "relay unavailable" }` (state already consumed — retry redoes
  the whole flow cleanly); GitHub-exchange failures remain 401. Injected
  `oauthStore` seam in `ServerOptions` for shaping failures in tests.
  (DONE 2026-09-16; Plan 4, Task 2 ledger)
- [x] Redis-side room readiness for horizontal relay scaling — design
  documented in-code at the `roomMembers` gate in
  `packages/relay/src/socket.ts` (origin/epoch scheme + sweeper + the
  silent-drop failure mode). Implementation deferred until scaling work
  actually starts, per the original note. (DONE 2026-09-16; Plan 1, Task 7)
- [x] Replay detection: plaintext `sender` (random per socket instance) +
  monotonic `seq` header on `EncryptedEnvelope` (NOT in `meta` — meta is
  inside the cipher); both sockets stamp on send; the relay drops unstamped
  and non-advancing frames per (room, sender) before fanout, cleaning up
  when a room empties. Threat model decided: warranted — the window is the
  room TTL and captured frames could reorder/duplicate the agent feed.
  (DONE 2026-09-16; Plans 3-4 final reviews)

## Testing gaps

- [x] `onFatal` (wrong-key) close-path contract test on the relay socket layer —
  both `CaderoSocket` and `MobileSocket` now covered against the real relay:
  onFatal fires exactly once, no event crosses, and the socket never
  reconnects. (DONE 2026-09-16)
- [x] DENY-path keystroke test at the socket layer (`"\u001b"` write reaches
  the agent PTY through the real relay). Writing it exposed a real bug: the
  session's final frames raced the socket close (async encryption vs a
  synchronous `close()` — the transport silently discarded them); fixed by
  awaiting the exit flush before closing (`session.ts` `handleExit`).
  (DONE 2026-09-16)
- [x] `room_id`-mismatch routing test — an envelope addressed to a different
  room is dropped (core routing-integrity rule now pinned). (DONE 2026-09-16)
- [x] Camera-scan E2E path: faked `getUserMedia` (canvas stream rendering a
  QR of the real pairing payload) drives the PWA's jsQR scanner end to end.
  (DONE 2026-09-16)
- [x] Staleness soak test: child relay process SIGSTOP'd mid-session (half-
  open TCP); the phone recovers via the 45s force-reconnect once the relay
  resumes. Gated behind `RUN_SOAK=1` (~70s). (DONE 2026-09-16)
- [x] E2E CI wiring: `retries: 1` + explicit list reporter in
  `packages/e2e/playwright.config.ts`, and a CI job (Redis service +
  `npm run e2e`) in `.github/workflows/ci.yml` (unit + e2e jobs, artifact
  upload on failure). (DONE 2026-09-16)
- [ ] Real-device PWA validation (iOS Safari PWA install/behavior) beyond the
  headless chromium E2E. (Plan 3 final review)

## Ops / deployment

- [x] Compose healthchecks on redis and relay (`depends_on` now gates on
  `service_healthy`; relay's check polls `/health` and fails while
  `"redis": "down"`). (DONE 2026-09-16)
- [x] Relay runtime image prune: the multi-stage build copied the full
  `node_modules` including devDeps; the build stage now runs
  `npm prune --omit=dev` before the runtime COPY. (DONE 2026-09-16)
- [x] Add `.git` to root `.dockerignore`. (DONE 2026-09-16)
- [x] First `/health` ping after relay boot reported `"redis": "down"` —
  verified already fixed pre-sweep: eager `redis.connect()` warm-up + a
  bounded retry loop inside `/health` exist in `createServer`. (DONE 2026-09-16)
- [x] Validate `CADERO_INTERCEPT_TIMEOUT_MS` before pairing/connecting instead
  of after — validation now runs before `pairSession`, so an invalid value
  exits 1 without wasting a relay connection or pairing payload.
  (DONE 2026-09-16)

## Product / UX

- [x] Phone-native camera pairing (DONE 2026-09-16, native QR print REVERTED
  same day per session feedback — "let users use the PWA for now"): the PWA
  still accepts `https://<relay>/#pair=<urlencoded payload>` deep links
  (stash in sessionStorage, auto-import after GitHub sign-in; covered by
  `appFlow.test.tsx`), but the CLI no longer prints a second native-camera
  QR. Re-enable the printed deep link when the phone flow warrants it.
- [x] Multi-session switcher — DONE, see the dedicated entry further below in
  this section.
- [x] Parked: opencode E2E final assertion is intermittent — the planned
  next-step instrumentation already ships: the `?debug=1` status element
  shows the phone-side frame count (`frames:`) alongside phase/gapped/
  intercept, plus `[e2e-trace]` console traces and ws frame instrumentation.
  The flake itself remains parked (retries: 1 absorbs it in CI).
  (DONE 2026-09-16)
- [x] Attach to an agent session started *outside* Cadero (plain `claude` in
  a normal terminal): documented as unsupported in the README multi-session
  section (the daemon must own the PTY from process start; OS-level PTY
  hijacking is the only attach route and is a security-model question).
  (DONE 2026-09-16)
- [x] xterm `.xterm-rows` overflows over the Send button in narrow/headless
  viewports — fixed with `overflow-hidden` + z-order on the terminal host
  container (`TerminalView.tsx`). (DONE 2026-09-16)
- [x] Document `--agent <claude|opencode|codex>` in the README config table
  (including the codex option beyond the backlog's original two).
  (DONE 2026-09-16)
- [ ] Real-device PWA validation — manual checklist (needs a physical phone):
  1. iOS Safari: PWA install (Add to Home Screen), standalone launch, no
     browser chrome.
  2. Pair via the native camera QR → GitHub sign-in → auto-import → live.
  3. Pair a second `cadero start` session; switch tabs on the phone;
     verify background rooms buffer output and the approval badge shows.
  4. Reload the PWA mid-session: sessions reconnect from the stash.
  5. Keyboard: viewport refit on keyboard open/close (resize frames),
     Enter-to-send, prompt gating while an intercept is pending.
  6. Suspend the phone (background) for ~2 min; verify GAP banner +
     auto-reconnect on return.
- [x] Multi-session switcher (DONE 2026-09-16, superseding the original design
  constraints): the phone holds **all paired rooms connected concurrently** —
  every room gets its own `MobileSocket` with heartbeat/staleness/auto-
  reconnect, per-room terminal buffers, and a room tab bar with
  pending-approval badges. Sessions persist in **sessionStorage** (raw key
  material, restored on load; cleared when the tab closes). Zero-knowledge
  posture unchanged: the relay still never sees any key — the trade is that
  keys now rest in per-tab browser storage (documented in
  `packages/mobile/src/app/oauth.ts`). Store: `packages/mobile/src/state/sessionStore.ts`
  (14 unit tests); UI tabs/refill/routing: `CaderoApp.tsx` (5 component tests).
- [ ] Parked: opencode E2E final assertion is intermittent — the phone's
  terminal intermittently misses the approval echo (" approved:") after the
  overlay's Approve tap, while the CLI side mirrors it correctly. The
  always-mounted TerminalView's refit after the phase transition is the
  prime suspect (the received frames arrive per the ws instrumentation —
  trace logs saved in /tmp/e2e*.log, instrumentation included: relay
  join/publish traces, page console capture, a ?debug=1 status element in
  the PWA). The real-device flow worked when the dialog was approved, so
  this is a CI-coverage gap, not a phone-flow blocker. Next step: phone-side
  frame-count instrumentation (?debug=1 status element) to pin the failing
  layer. (Session feedback 2026-09-15)
- [ ] Attach to an agent session started *outside* Cadero (plain `claude` in
  a normal terminal): currently impossible by design — the daemon must own
  the PTY from process start to intercept prompts, mirror output, and sync
  viewport size, and the session key exists only for Cadero-spawned
  sessions. OS-level PTY hijacking (ptrace/tty redirection) is the only
  attach route and is fragile + a security-model question. Document the
  limitation in the README. (Session feedback 2026-09-15)
- [ ] xterm `.xterm-rows` overflows over the Send button in narrow/headless
  viewports (verified via `elementFromPoint` during E2E work; Enter-to-submit
  works and is the tested path). Layout pass: `overflow-hidden` on the
  terminal container or a z-order fix. (Plan 4, Task 8)
- [ ] Document `--agent <claude|opencode>` in the README config table (currently
  discoverable via `cadero --help`; defaults to `claude`). (Plan 4, Task 9)

## Test hygiene (cosmetic, batch opportunistically)

- [x] Protocol schema rejection tests: bad `agent` enum, empty
  `prompt`/`reason` strings, bad `timestamp`, empty `session_id`, unknown
  event types (`packages/protocol/tests/events.test.ts`). (DONE 2026-09-16)
- [x] `redactForLog` branch tests (non-object, missing `room_id`, non-string
  `room_id`) (`packages/relay/tests/logging.test.ts`). (DONE 2026-09-16)
- [x] Envelope: attach `{ cause }` to `EnvelopeError` for diagnostics — all
  three failure reasons carry the underlying error/zod issue.
  (DONE 2026-09-16)
- [x] Close-code contract tests: explicit error handlers + a 10s internal
  deadline (a connect-refused race fails fast instead of hanging to the
  suite timeout). (DONE 2026-09-16)
- [x] Bound the reconnect `readyState` polls in both socket test twins with
  internal deadlines. (DONE 2026-09-16)
- [x] Comment the `""` session_id sentinel in `MobileSocket` heartbeat
  (triggers the UUID stamp in `send`). (DONE 2026-09-16)
- [x] Remove unused key-helper imports in the socket tests; unstub
  `vi.stubGlobal` in the terminal test; remove the dead `fitRef` in
  `TerminalView`. (DONE 2026-09-16)
- [x] `@types/qrcode` in mobile devDeps — N/A as written: no mobile test
  imports qrcode (the E2E package holds the dependency).
  (DONE 2026-09-16)
- [x] `npm audit` triage: 7 findings (4 moderate, 2 high, 1 critical), ALL
  dev/build-time only — vitest/vite/esbuild (test tooling) and postcss
  (bundled inside Next's build). None reach the relay runtime image or the
  shipped PWA bundle. Fixes are breaking majors (vitest 5, next 16) —
  deliberately NOT force-upgraded in a hygiene batch; revisit when those
  majors are scheduled. (DONE 2026-09-16)

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
