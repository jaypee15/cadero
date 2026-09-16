# Cadero UX redesign (landing + app polish) — design

Date: 2026-09-16 | Status: approved (Approach A)

## Goals

1. cadero.dev is a **public-facing product** page: anonymous visitors get real
   context (what Cadero is, how it works, security model), users get the app.
2. The app gets a refined dark developer identity: wordmark, one accent,
   deliberate type scale and spacing — no framework change (Next + Tailwind).
3. Named sessions replace opaque `Room 1234` labels.
4. No scope creep: no light theme, no in-app renaming, no install banner.

## Structure

- **`/` — marketing landing** (static, no auth): hero, how-it-works (3 steps:
  `cadero start` → scan → approve from anywhere), security model in plain
  language, footer. CTA → `/app`.
- **`/app` — the PWA** (today's CaderoApp, restyled).
- **Hash forwarding**: OAuth returns `#token=` to `CADERO_APP_URL` (the
  domain root). The landing detects a `#token=`/`#pair=` hash client-side and
  immediately forwards to `/app` preserving the fragment, so the OAuth env
  quartet does not change. Direct `/app#token=` visits also work.

## Named sessions

- Pairing payload gains an optional label: compact form
  `cadero://p?r=&m=&k=&l=<urlencoded label>` (long form `label=`). Absent →
  fall back to `Room <last4>`.
- CLI builds the label as `<agent> · <basename(cwd)>` (URL-encoded).
- Mobile store: `SessionView.label` from the payload; persisted with the
  session; shown in tabs/badges. Pairing payload length grows ~25 chars —
  QR stays scannable (error-correction low).

## Visual identity (refined dark developer brand)

- Design tokens in `globals.css` (Tailwind v4 `@theme`): background scale
  around slate-950/900, single accent `emerald-500`, consistent text scale.
- `Wordmark` component: inline SVG glyph (terminal-prompt chevron) + "Cadero"
  text; used on the landing hero and the app welcome screen. No image assets.
- Dark-first everywhere (it is a terminal tool).

## Screens (all in `/app`)

- **Signed-out welcome**: wordmark, one-line pitch ("Control your AI coding
  agents from your phone"), GitHub sign-in as the primary CTA.
- **Pairing**: numbered steps (1 Sign in ✓ → 2 Scan the QR); camera video in
  a rounded framed view with a status line; manual paste collapsed under an
  "Advanced" disclosure; errors surfaced under the step they belong to.
- **Live**: terminal-first full-bleed; polished tab bar (session labels,
  pending-approval badge, close per tab, `+ Pair`); connecting state shows a
  spinner + room label; gap banner and intercept overlay restyled for
  consistency; closed screen gains a "Pair another session" action.
- **Closed**: reason + actions (pair another session / retry).

## Non-goals

- No backend/protocol changes beyond the optional `label` payload field.
- No new routes beyond `/` and `/app` (no docs page, no pricing).
- No service worker/install banner in this pass.

## Testing

- Protocol tests for the `label` field (parse/absent/invalid-tolerance).
- Store tests: label flows through addSession/persistence/restore.
- appFlow tests: welcome screen (signed-out), pairing steps, auto-import
  still works (`#pair=` at `/app`).
- Landing smoke test: hero renders, CTA links to `/app`, hash forwarding.
- E2E paths updated for `/app` (baseURL navigation in `pair()`).
