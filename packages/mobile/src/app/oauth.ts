// packages/mobile/src/app/oauth.ts

// The OAuth bearer token lives in sessionStorage so a page reload keeps you
// signed in (cleared when the tab closes).
//
// Session keys: the RELAY never sees any key (zero-knowledge transport, the
// pairing QR is the key's only carrier across the wire). Paired room keys DO
// rest in sessionStorage (per-tab, never synced, gone when the tab closes)
// so the phone can hold several paired sessions across reloads — a
// deliberate convenience trade: keys never leave the device or reach the
// relay, but they are readable by this origin's JS while the tab lives.
const TOKEN_STORAGE_KEY = "cadero_oauth_token";
const PAIRING_STASH_KEY = "cadero_pairing_stash";

export function storeToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    /* storage unavailable (private mode): token stays memory-only */
  }
}

export function readStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function readOAuthTokenFromHash(): string | null {
  const hash = window.location.hash;
  const match = hash.match(/^#token=([A-Za-z0-9_]+)$/);
  if (!match) return null;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return match[1];
}

// The CLI prints an https deep link (https://<relay>/#pair=<urlencoded
// payload>) so a NATIVE phone camera can complete pairing: the PWA reads the
// payload on load and auto-imports it once the user is signed in. URL
// fragments never survive the OAuth redirect, so the payload is stashed in
// sessionStorage first.
export function readPairingFromHash(): string | null {
  const match = window.location.hash.match(/^#pair=([A-Za-z0-9%._~-]+)$/);
  if (!match) return null;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  let payload: string;
  try {
    payload = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  try {
    sessionStorage.setItem(PAIRING_STASH_KEY, payload);
  } catch {
    /* stash unavailable: the payload is consumed immediately below anyway */
  }
  return payload;
}

export function readPairingStash(): string | null {
  try {
    return sessionStorage.getItem(PAIRING_STASH_KEY);
  } catch {
    return null;
  }
}

export function clearPairingStash(): void {
  try {
    sessionStorage.removeItem(PAIRING_STASH_KEY);
  } catch {
    /* nothing to clear */
  }
}

export function loginUrl(relay: string): string {
  return `${relay}/v1/oauth/login`;
}
