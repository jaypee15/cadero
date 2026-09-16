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

export function loginUrl(relay: string): string {
  return `${relay}/v1/oauth/login`;
}
