# Deploying Cadero to a Contabo VPS with Cloudflare

Architecture after this walkthrough:

```
phone / dev machine
        │  https://cadero.dev (Cloudflare edge, WSS ok)
        ▼
Cloudflare proxy (orange cloud)
        │  Full (strict) TLS
        ▼
Contabo VPS — docker compose: nginx (443, origin cert) → relay → redis
```

## 0. What you need before starting

- The Contabo VPS (Ubuntu 24.04 LTS assumed) with root SSH access.
- `cadero.dev` in your Cloudflare account.
- Both GitHub OAuth apps registered (see [setup-oauth.md](setup-oauth.md)):
  CLI client id, relay client id + secret.

## 1. Cloudflare DNS

In the Cloudflare dashboard → `cadero.dev` → DNS:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `@` | `<VPS IPv4>` | Proxied (orange) |

- Proxied mode is what hides the VPS IP and gives you DDoS protection.
- TLS mode: **SSL/TLS → Overview → Full (strict)**. This forces Cloudflare to
  validate the origin certificate installed in step 4.

## 2. Cloudflare origin certificate (no renewals, ~15-year validity)

SSL/TLS → Origin Server → Create Certificate:

- Private key type: RSA (2048).
- Hostnames: `cadero.dev`, `*.cadero.dev`.
- Validity: 15 years.

Copy the certificate and private key — step 4 puts them on the VPS as
`certs/origin.pem` and `certs/origin.key` (gitignored; never commit them).

## 3. VPS preparation

```bash
ssh root@<VPS_IP>

# firewall: ssh, http (redirect), https (cloudflare origin traffic)
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable

# docker (official convenience script)
curl -fsSL https://get.docker.com | sh

# git
apt-get update -y && apt-get install -y git
```

Cloudflare→origin traffic only arrives on 443 (and 80 for the redirect), so
`8080` stays closed to the world.

## 4. Ship the stack

```bash
git clone https://github.com/jaypee15/cadero.git && cd cadero

# TLS: paste the Cloudflare origin cert + key from step 2
mkdir -p certs
nano certs/origin.pem   # paste "Origin Certificate" block
nano certs/origin.key   # paste "Private Key"

# env: copy the example and fill in the quartet + nothing else
cp .env.example .env
nano .env
```

`.env` must contain the OAuth quartet (`GITHUB_OAUTH_CLIENT_ID`,
`GITHUB_OAUTH_CLIENT_SECRET`, `CADERO_RELAY_PUBLIC_URL=https://cadero.dev`,
`CADERO_APP_URL=https://cadero.dev`).

In your GitHub **relay** app, make sure the callback URL is exactly
`https://cadero.dev/v1/oauth/callback`.

```bash
docker compose up -d
```

## 5. Verify

```bash
curl -s https://cadero.dev/health
# {"status":"ok","redis":"up"}
curl -s -o /dev/null -w "%{http_code}\n" https://cadero.dev/
# 200
```

Also confirm in the Cloudflare dashboard: DNS shows the orange cloud, and
SSL/TLS mode reads Full (strict). If `/health` hangs, check that 443 is open
(`ufw status`) and that the certs directory was populated **before**
`docker compose up` (nginx exits if the cert pair is missing).

## 6. On your dev machine

```bash
git clone https://github.com/jaypee15/cadero.git && cd cadero
npm install && npm run build
npm link ./packages/cli

export CADERO_GITHUB_CLIENT_ID=<cli-app-client-id>
cadero-cli login          # device flow: approve the code at github.com/login/device
cadero-cli start --relay-url https://cadero.dev
```

Scan the terminal QR with your phone — the PWA at `https://cadero.dev` goes
live with your local agent session.

## Notes

- **WebSockets** proxy fine through Cloudflare; Cadero's 20s heartbeat keeps
  the connection comfortably alive under Cloudflare's idle timeouts.
- **Updates**: `git pull && docker compose build && docker compose up -d`.
- **Sessions are ephemeral by design** — restarting the stack drops live rooms
  (4h Redis TTL applies); the agent daemon exits and you pair a new session.
- The CLI can run anywhere your code lives (same machine, laptop, etc.) — it
  only needs outbound HTTPS to the relay, so you can also run it on the VPS
  itself if your agent work happens there.
