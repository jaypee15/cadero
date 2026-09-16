export interface ParsedPairing {
  relay: string;
  room: string;
  key: string;
  /** Human label (e.g. "claude · cadence"); absent for legacy payloads. */
  label?: string;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LABEL_MAX_CHARS = 64;

function parseLabel(raw: string | null): string | undefined {
  if (!raw) return undefined;
  if (raw.length > LABEL_MAX_CHARS) {
    throw new Error("not a cadero pairing payload");
  }
  return raw;
}

export function parsePairingPayload(payload: string): ParsedPairing {
  let url: URL;
  try {
    url = new URL(payload);
  } catch {
    throw new Error("not a cadero pairing payload");
  }
  // Long form: cadero://pair?v=1&relay=…&room=…&key=…
  // Compact form: cadero://p?r=<relay>&m=<room>&k=<key>  (smaller QR)
  if (url.protocol === "cadero:" && url.hostname === "pair" && url.searchParams.get("v") === "1") {
    const relay = url.searchParams.get("relay");
    const room = url.searchParams.get("room");
    const key = url.searchParams.get("key");
    if (!relay || !room || !key || !KEY_PATTERN.test(key)) {
      throw new Error("not a cadero pairing payload");
    }
    const label = parseLabel(url.searchParams.get("label"));
    return label !== undefined ? { relay, room, key, label } : { relay, room, key };
  }
  if (url.protocol === "cadero:" && url.hostname === "p") {
    const rawRelay = url.searchParams.get("r");
    const room = url.searchParams.get("m");
    const key = url.searchParams.get("k");
    if (!rawRelay || !room || !key || !KEY_PATTERN.test(key)) {
      throw new Error("not a cadero pairing payload");
    }
    // A bare host means the production https edge (dev relays carry the
    // explicit http scheme).
    const relay = rawRelay.includes("://") ? rawRelay : `https://${rawRelay}`;
    const label = parseLabel(url.searchParams.get("l"));
    return label !== undefined ? { relay, room, key, label } : { relay, room, key };
  }
  throw new Error("not a cadero pairing payload");
}
