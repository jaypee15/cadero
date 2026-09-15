# Deploying Cadero with Dokploy on a Contabo VPS

Architecture after this walkthrough:

```
phone / dev machine
        │  https://cadero.dev (Cloudflare edge, WSS ok)
        ▼
Cloudflare proxy (orange cloud)
        │  Full (strict) TLS
        ▼
Contabo VPS — Dokploy: Traefik (TLS, Let's Encrypt) → web nginx → relay → redis
```

Dokploy owns the edge (Traefik terminates TLS with an auto-renewing
Let's Encrypt certificate), so the Cadero stack deploys as one Docker Compose
service with its nginx left plain-HTTP behind Traefik. The compose file the
service runs is `dokploy.yml` in the repo root.

## 1. Install Dokploy on the VPS

On the bare Contabo VPS (Ubuntu 24.04 assumed):

```bash
ssh root@<VPS_IP>
curl -sSL https://dokploy.com/install.sh | sh
```

The installer brings Docker, Traefik (ports 80/443), and the Dokploy web UI
(port 3000). Open the firewall:

```bash
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 3000/tcp && ufw enable
```

Close `3000` later once the dashboard has its own domain, or keep it IP-restricted.

## 2. Dokploy first-run + Let's Encrypt

Open `http://<VPS_IP>:3000`, create the admin account, then **enable
Let's Encrypt explicitly**:

**Settings → Server → Web Server → Traefik**: toggle *Enable Let's Encrypt*
and enter your email → Save (Traefik recreates with the `letsencrypt`
resolver). This is required — the routing labels in `dokploy.yml` reference
`certresolver=letsencrypt`, and without this toggle they silently produce no
certificate, which surfaces as Cloudflare error **526**.

## 3. Create the Cadero service

In the Dokploy dashboard:

1. **Projects → Create project**, name it `cadero`.
2. Inside the project, **Create service → Docker Compose**.
3. Source: your GitHub repo (`jaypee15/cadero`), branch `main`.
4. **Compose Path**: `dokploy.yml`.
5. **Environment** tab — the OAuth quartet (all four together; the relay fails
   loudly on partial sets):
   ```
   GITHUB_OAUTH_CLIENT_ID=...
   GITHUB_OAUTH_CLIENT_SECRET=...
   CADERO_RELAY_PUBLIC_URL=https://cadero.dev
   CADERO_APP_URL=https://cadero.dev
   ```
6. **Deploy**. Dokploy clones the repo and builds the three images (redis is
   pulled). First build takes a few minutes.

In your GitHub **relay** OAuth app, make sure the callback URL is exactly
`https://cadero.dev/v1/oauth/callback`.

## 4. Cloudflare

DNS → add:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `@` | `<VPS IPv4>` | Proxied (orange) |

SSL/TLS → Overview → **Full (strict)**.

The orange cloud gives you DDoS protection and hides the VPS IP. Let's Encrypt
HTTP-01 renewal passes through the proxy fine (Cloudflare forwards
`/.well-known/acme-challenge` to Traefik on port 80).

## 5. Verify

```bash
curl -s https://cadero.dev/health
# {"status":"ok","redis":"up"}
curl -s -o /dev/null -w "%{http_code}\n" https://cadero.dev/
# 200
curl -s -o /dev/null -w "%{http_code}\n" http://cadero.dev/
# 301 (redirected to https)
```

If `/health` hangs: check the service logs in Dokploy (Deployment → Logs), and
confirm the `dokploy-network` exists (`docker network ls` — Dokploy creates it
during install). If Let's Encrypt issuance fails through the Cloudflare proxy,
switch Dokploy's server settings to the DNS challenge with a Cloudflare API
token (Zone → DNS → Edit for `cadero.dev`).

### Troubleshooting: Cloudflare error 526

526 means Cloudflare reached the VPS but Traefik served no valid certificate
for the domain. Routing for compose services is label-driven (already in
`dokploy.yml` — you don't add the domain in the UI), so check in this order:

```bash
docker ps --format '{{.Names}}\t{{.Status}}'                # stack + traefik running?
docker network inspect dokploy-network \
  --format '{{range .Containers}}{{.Name}} {{end}}'         # traefik AND cadero-web-1 present?
docker logs dokploy-traefik --tail 100 2>&1 \
  | grep -iE "cadero|acme|letsencrypt|error"                 # issuance attempts/errors
```

- Stack containers missing → the deploy failed; check the service logs in
  Dokploy (commonly: Environment tab missing the OAuth quartet).
- Web not on `dokploy-network` → redeploy the service.
- No ACME activity / "resolver not found" → Let's Encrypt was never enabled
  (see step 2).
- Bypass Cloudflare to isolate: from the VPS,
  `curl -sk --resolve cadero.dev:443:127.0.0.1 https://cadero.dev/health`.
  `200` here means the origin is fine and the issue is stale — wait a minute.

## 6. On your dev machine

```bash
git clone https://github.com/jaypee15/cadero.git && cd cadero
npm install && npm run build
npm link ./packages/cli

export CADERO_GITHUB_CLIENT_ID=<cli-app-client-id>
cadero-cli login          # approve the code at github.com/login/device
cadero-cli start --relay-url https://cadero.dev
```

Scan the terminal QR with your phone — `https://cadero.dev` goes live with
your local agent session.

## Notes

- **WebSockets** proxy fine through both Traefik and Cloudflare; Cadero's 20s
  heartbeat keeps sessions alive under their idle timeouts.
- **Updates**: Dokploy → your service → Redeploy (it re-clones and rebuilds).
- **Sessions are ephemeral by design** — redeploying restarts the stack and
  drops live rooms (4h Redis TTL applies); the agent daemon exits and you pair
  a fresh session.
- **Dashboard security**: once the dashboard has a domain, close port 3000
  (`ufw delete allow 3000/tcp`) — Dokploy routes the dashboard domain through
  Traefik like any other service.
- Prefer no PaaS? The stack also runs standalone with
  `docker compose up -d` (port 8080) — see the README quickstart.
