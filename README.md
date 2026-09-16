# Cadero

Control your local AI coding agents (Claude Code, OpenCode, Codex) from your
phone. Cadero runs a daemon next to your agents, routes encrypted frames
through a thin relay, and renders the live terminal in a mobile PWA with
approve/deny controls for every action the agent wants to take.

## Security model

- Zero-knowledge relay: the relay sees only room ids and ciphertext. A
  per-session AES-GCM-256 key is generated on your machine and delivered to
  your phone exclusively via the terminal QR code. The relay never sees any
  key material; phone-side keys rest in per-tab `sessionStorage` (cleared
  when the tab closes) so several paired sessions survive a reload. The
  OAuth session token also lives in `sessionStorage`.
- Local final veto: the daemon never executes shell commands from the
  network. Your phone sends high-level intents; the daemon validates
  everything and only ever feeds your existing agent's stdin.
- Optional safelist: `.caderorc` (`{"safeCommands": ["npm test", ...]}`)
  auto-approves listed commands without bothering your phone.

## Quickstart (self-host)

1. `docker compose up -d` — starts Redis, the relay, and the PWA (port 8080,
   plain HTTP — TLS terminates at your edge). For the full VPS deployment with
   Dokploy (Traefik + Let's Encrypt) see
   [docs/deploy-contabo.md](docs/deploy-contabo.md).
2. Register the two GitHub OAuth apps and set the env vars (see
   [docs/setup-oauth.md](docs/setup-oauth.md) for the walkthrough), then restart.
3. On your dev machine, install the CLI from source (not yet published to npm):
   ```
   git clone https://github.com/jaypee15/cadero.git
   cd cadero
   npm install
   npm run build
   npm link ./packages/cli
   ```
4. `cadero login` (requires `CADERO_GITHUB_CLIENT_ID` in your env)
5. `cadero start --relay-url https://cadero.dev`
6. Scan the terminal QR with your phone. Each `cadero start` creates its own
   room; the phone keeps every paired session connected with a tab switcher.

## Multi-session

Every `cadero start` runs one agent in its own room. The phone pairs to
as many rooms as you like and keeps them all connected: a tab bar switches
between them, pending approvals show an amber badge on their tab, and
sessions survive page reloads (per-tab `sessionStorage`, cleared when the
tab closes). To attach to an agent session that was started *outside*
Cadero (plain `claude` in a normal terminal): not supported — the daemon
must own the PTY from process start to intercept prompts, mirror output,
and keep the viewport in sync; there is no safe way to attach after the
fact.

## Configuration

| Variable | Where | Purpose |
|---|---|---|
| `CADERO_GITHUB_CLIENT_ID` | CLI env | GitHub OAuth app client id for `cadero login` |
| `CADERO_RELAY_URL` | CLI flag/env | Relay base URL (default: required at start) |
| `CADERO_INTERCEPT_TIMEOUT_MS` | CLI env | Intercept timeout override (default 900000 = 15 min) |
| `CADERO_MIRROR_GRACE_MS` | CLI env | How long the terminal keeps agent output hidden so the QR stays scannable (default 60000 = 60s; raise it if your first-run phone pairing takes longer) |
| `--agent <claude\|opencode\|codex>` | CLI flag | Which agent harness to run (default `claude`; discoverable via `cadero --help`) |
| `REDIS_URL` | relay env | Redis connection string (compose sets it) |
| `PORT` | relay env | Relay listen port (default 8787) |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | relay env | OAuth portal (503 when unset) |
| `CADERO_RELAY_PUBLIC_URL` | relay env | Public base URL for OAuth redirects |
| `CADERO_APP_URL` | relay env | Where the OAuth callback redirects the browser |

## Development

```
npm install
npm run build && npm test && npm run typecheck
npm run e2e   # full-loop browser test (from packages/e2e; see that package for prerequisites)
```

## License

MIT — see [LICENSE](LICENSE).
