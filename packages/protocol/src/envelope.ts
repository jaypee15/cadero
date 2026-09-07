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

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(raw: string): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(raw, "base64");
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

export async function generateSessionKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptEnvelope(
  roomId: string,
  key: CryptoKey,
  event: WireEvent,
): Promise<EncryptedEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(JSON.stringify(event)),
  );
  return {
    room_id: roomId,
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(encoded)),
  };
}

export async function decryptEnvelope(
  key: CryptoKey,
  envelope: EncryptedEnvelope,
): Promise<WireEvent> {
  const parsed = EncryptedEnvelopeSchema.parse(envelope);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(parsed.iv) },
    key,
    fromBase64(parsed.ciphertext),
  );
  return WireEventSchema.parse(JSON.parse(textDecoder.decode(plain)));
}
