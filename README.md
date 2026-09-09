# Cadence

Control your local AI coding agents (Claude Code, OpenCode) from your phone.
Cadence runs a daemon next to your agents, routes encrypted frames through a
thin relay, and renders the live terminal in a mobile PWA with approve/deny
controls for every action the agent wants to take.

## Security model

- Zero-knowledge relay: the relay sees only room ids and ciphertext. A
  per-session AES-GCM-256 key is generated on your machine and delivered to
  your phone exclusively via the terminal QR code.
- Local final veto: the daemon never executes shell commands from the
  network. Your phone sends high-level intents; the daemon validates
  everything and only ever feeds your existing agent's stdin.
- Optional safelist: `.cadencerc` (`{"safeCommands": ["npm test", ...]}`)
  auto-approves listed commands without bothering your phone.

## Quickstart (self-host)

1. `docker compose up -d` — starts Redis, the relay, and the PWA (port 8080).
2. Register the two GitHub OAuth apps and set the env vars (see
   [docs/setup-oauth.md](docs/setup-oauth.md) for the walkthrough), then restart.
3. On your dev machine, install the CLI from source (not yet published to npm):
   ```
   git clone https://github.com/jaypee15/cadence.git
   cd cadence
   npm install
   npm run build
   npm link ./packages/cli
   ```
4. `cadence-cli login` (requires `CADENCE_GITHUB_CLIENT_ID` in your env)
5. `cadence-cli start --relay-url http://your-server:8080`
6. Scan the terminal QR with your phone.

## Configuration

| Variable | Where | Purpose |
|---|---|---|
| `CADENCE_GITHUB_CLIENT_ID` | CLI env | GitHub OAuth app client id for `cadence-cli login` |
| `CADENCE_RELAY_URL` | CLI flag/env | Relay base URL (default: required at start) |
| `CADENCE_INTERCEPT_TIMEOUT_MS` | CLI env | Intercept timeout override (default 900000 = 15 min) |
| `REDIS_URL` | relay env | Redis connection string (compose sets it) |
| `PORT` | relay env | Relay listen port (default 8787) |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | relay env | OAuth portal (503 when unset) |
| `CADENCE_RELAY_PUBLIC_URL` | relay env | Public base URL for OAuth redirects |
| `CADENCE_APP_URL` | relay env | Where the OAuth callback redirects the browser |

## Development

```
npm install
npm run build && npm test && npm run typecheck
npm run e2e --workspace=@cadence/mobile   # full-loop browser test
```

## License

MIT — see [LICENSE](LICENSE).
