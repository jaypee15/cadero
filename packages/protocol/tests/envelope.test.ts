import { describe, expect, it } from "vitest";
import {
  decryptEnvelope,
  encryptEnvelope,
  EncryptedEnvelopeSchema,
  generateSessionKey,
  type EncryptedEnvelope,
} from "../src/envelope.js";

const event = {
  event: "TERMINAL_DATA",
  meta: { session_id: "sess_1" },
  payload: { chunk: "secret bytes" },
} as const;

describe("envelope", () => {
  it("round-trips an event through AES-GCM", async () => {
    const key = await generateSessionKey();
    const envelope = await encryptEnvelope("room_abc", key, event);
    expect(EncryptedEnvelopeSchema.safeParse(envelope).success).toBe(true);
    const back = await decryptEnvelope(key, envelope);
    expect(back).toEqual(event);
  });

  it("ciphertext does not contain the plaintext chunk", async () => {
    const key = await generateSessionKey();
    const envelope: EncryptedEnvelope = await encryptEnvelope("room_abc", key, event);
    expect(envelope.ciphertext).not.toContain("secret bytes");
    expect(envelope.room_id).toBe("room_abc");
  });

  it("decryption with the wrong key fails", async () => {
    const key = await generateSessionKey();
    const other = await generateSessionKey();
    const envelope = await encryptEnvelope("room_abc", key, event);
    await expect(decryptEnvelope(other, envelope)).rejects.toThrow();
  });
});
