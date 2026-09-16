import {
  exportSessionKey,
  generateSessionKey,
  importSessionKey,
} from "@cadero/protocol";

export interface PairingInfo {
  roomId: string;
  sessionKey: CryptoKey;
  qrPayload: string;
}

export async function pairSession(
  relayUrl: string,
  githubToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PairingInfo> {
  const res = await fetchImpl(`${relayUrl}/v1/pair`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken}`,
      "User-Agent": "cadero",
    },
  });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("saved login was rejected (HTTP 401) — run: cadero login");
    }
    throw new Error(`pairing failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { room_id?: unknown };
  if (typeof body.room_id !== "string" || body.room_id.length === 0) {
    throw new Error("pairing response missing room_id");
  }
  const roomId = body.room_id;
  const sessionKey = await generateSessionKey();
  const raw = await exportSessionKey(sessionKey);
  // Compact payload form — a shorter string means a smaller QR matrix.
  // https relays emit a bare host (the parser assumes the scheme); explicit
  // schemes (e.g. http://localhost:8787 in dev) are carried in full.
  const relayField = relayUrl.startsWith("https://") ? relayUrl.slice("https://".length) : relayUrl;
  const qrPayload = `cadero://p?r=${encodeURIComponent(relayField)}&m=${roomId}&k=${raw}`;
  return { roomId, sessionKey, qrPayload };
}

export { parsePairingPayload, type ParsedPairing } from "@cadero/protocol";

// Re-export so mobile-side tooling and tests can import from one place.
export { importSessionKey };
