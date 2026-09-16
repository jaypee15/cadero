# Cadero GitHub OAuth App Setup

Cadero authenticates users through two GitHub OAuth apps. Register both at
[github.com/settings/developers](https://github.com/settings/developers)
(**Settings → Developer settings → OAuth Apps → New OAuth App**). Plain OAuth
Apps are the right type — Cadero only verifies user identity and requests the
`read:user` scope.

## Why two apps

| | CLI app | Relay app |
|---|---|---|
| Flow | Device code (RFC 8628) | Authorization code + redirect |
| Secret | Not needed | Required, lives only on the relay |
| Used by | `cadero login` | The mobile PWA's browser login |
| Why | The CLI runs in a terminal | Browsers can't call GitHub's device-flow endpoints (no CORS headers), so the relay hosts the redirect flow |

Keeping them separate means the secretless CLI app can ship on dev machines
while the secret-holding relay app is rotated without touching anything local.

## App 1 — CLI (device flow)

1. **New OAuth App**, name it e.g. `Cadero CLI`.
2. **Homepage URL**: your repo or product URL (unused by the flow, but required).
3. **Authorization callback URL**: unused by device flow, but the field is
   required — `http://localhost` is fine.
4. After creating, open the app page and tick **"Enable Device Flow"**.
   Without it, `cadero login` fails with `device flow error:
   unauthorized_client`.
5. Copy the **Client ID** and export it on your dev machine:

   ```bash
   export CADERO_GITHUB_CLIENT_ID=Iv1_xxxxxxxxxxxxxxxx
   ```

## App 2 — Relay (authorization code)

1. **New OAuth App**, name it e.g. `Cadero Relay`.
2. **Authorization callback URL** — must match your relay's public URL exactly:

   ```
   https://cadero.dev/v1/oauth/callback
   ```

3. After creating, click **"Generate a new client secret"** — GitHub shows it
   exactly once. Treat it like a password.
4. Put all four values in `.env` next to `docker-compose.yml` (start from
   `.env.example`):

   ```bash
   GITHUB_OAUTH_CLIENT_ID=Iv1_xxxxxxxxxxxxxxxx
   GITHUB_OAUTH_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   CADERO_RELAY_PUBLIC_URL=https://cadero.dev
   CADERO_APP_URL=https://cadero.dev
   ```

5. `docker compose up -d` (or `docker compose restart relay`). The relay fails
   loudly at startup if the quartet is incomplete — a clean boot is your wiring
   check.

`CADERO_RELAY_PUBLIC_URL` is the URL GitHub redirects back to, so it must be
publicly reachable with TLS in production. `CADERO_APP_URL` is where the
browser lands after login (the PWA).

## Local development

GitHub permits plain-HTTP callback URLs for localhost, so you can run the
whole portal locally:

- Relay app callback URL: `http://localhost:8787/v1/oauth/callback`
- Relay env: `CADERO_RELAY_PUBLIC_URL=http://localhost:8787`,
  `CADERO_APP_URL=http://localhost:3100` (the `next dev` port)

## Rotation

Generating a new client secret invalidates the old one immediately — brief
relay downtime while you update `.env` and restart. The CLI app needs no
rotation (device flow uses only the client ID).
