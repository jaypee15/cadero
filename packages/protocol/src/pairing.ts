export interface ParsedPairing {
  relay: string;
  room: string;
  key: string;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function parsePairingPayload(payload: string): ParsedPairing {
  let url: URL;
  try {
    url = new URL(payload);
  } catch {
    throw new Error("not a cadero pairing payload");
  }
  if (url.protocol !== "cadero:" || url.hostname !== "pair" || url.searchParams.get("v") !== "1") {
    throw new Error("not a cadero pairing payload");
  }
  const relay = url.searchParams.get("relay");
  const room = url.searchParams.get("room");
  const key = url.searchParams.get("key");
  if (!relay || !room || !key || !KEY_PATTERN.test(key)) {
    throw new Error("not a cadero pairing payload");
  }
  return { relay, room, key };
}
