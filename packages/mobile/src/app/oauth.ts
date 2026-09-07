// packages/mobile/src/app/oauth.ts
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
