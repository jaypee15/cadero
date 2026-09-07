import {
  exportSessionKey,
  generateSessionKey,
  importSessionKey,
} from "@cadence/protocol";

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
      authorization: `Bearer ${githubToken}`,
      "User-Agent": "cadence-cli",
    },
  });
  if (!res.ok) {
    throw new Error(`pairing failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { room_id?: unknown };
  if (typeof body.room_id !== "string" || body.room_id.length === 0) {
    throw new Error("pairing response missing room_id");
  }
  const roomId = body.room_id;
  const sessionKey = await generateSessionKey();
  const raw = await exportSessionKey(sessionKey);
  const qrPayload = `cadence://pair?v=1&relay=${encodeURIComponent(relayUrl)}&room=${encodeURIComponent(roomId)}&key=${raw}`;
  return { roomId, sessionKey, qrPayload };
}

export { parsePairingPayload, type ParsedPairing } from "@cadence/protocol";

// Re-export so mobile-side tooling and tests can import from one place.
export { importSessionKey };
