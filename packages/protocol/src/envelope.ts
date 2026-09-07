import { z } from "zod";
import { WireEventSchema, type WireEvent } from "./events.js";

export const EncryptedEnvelopeSchema = z.object({
  room_id: z.string().min(1),
  iv: z.string().min(1),
  ciphertext: z.string().min(1),
});

export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelopeSchema>;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(raw: string): Uint8Array<ArrayBuffer> {
  const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export async function generateSessionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export class EnvelopeError extends Error {
  constructor(
    public readonly reason:
      | "malformed_envelope"
      | "decryption_failed"
      | "invalid_event",
    message: string,
  ) {
    super(message);
    this.name = "EnvelopeError";
  }
}

export async function encryptRaw(
  roomId: string,
  key: CryptoKey,
  plaintext: string,
): Promise<EncryptedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(plaintext),
  );
  return {
    room_id: roomId,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(encoded)),
  };
}

export async function encryptEnvelope(
  roomId: string,
  key: CryptoKey,
  event: WireEvent,
): Promise<EncryptedEnvelope> {
  return encryptRaw(roomId, key, JSON.stringify(event));
}

export async function decryptEnvelope(
  key: CryptoKey,
  envelope: EncryptedEnvelope,
): Promise<WireEvent> {
  const parsed = EncryptedEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new EnvelopeError("malformed_envelope", "envelope failed schema validation");
  }
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(parsed.data.iv) },
      key,
      base64UrlToBytes(parsed.data.ciphertext),
    );
  } catch {
    throw new EnvelopeError("decryption_failed", "envelope failed to decrypt with this key");
  }
  let parsedEvent: unknown;
  try {
    parsedEvent = JSON.parse(textDecoder.decode(plain));
  } catch {
    throw new EnvelopeError("invalid_event", "decrypted payload is not JSON");
  }
  const event = WireEventSchema.safeParse(parsedEvent);
  if (!event.success) {
    throw new EnvelopeError("invalid_event", "decrypted payload is not a wire event");
  }
  return event.data;
}
