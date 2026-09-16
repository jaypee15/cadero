import { describe, expect, it } from "vitest";
import {
  decryptEnvelope,
  encryptEnvelope,
  EncryptedEnvelopeSchema,
  EnvelopeError,
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

  it("carries the replay header when given (plaintext, outside the cipher)", async () => {
    const key = await generateSessionKey();
    const envelope = await encryptEnvelope("room_abc", key, event, {
      sender: "abc123",
      seq: 7,
    });
    expect(envelope.sender).toBe("abc123");
    expect(envelope.seq).toBe(7);
    expect(EncryptedEnvelopeSchema.safeParse(envelope).success).toBe(true);
    const back = await decryptEnvelope(key, envelope);
    expect(back).toEqual(event);
  });

  it("stays schema-valid without a header (back-compat for local producers)", async () => {
    const key = await generateSessionKey();
    const envelope = await encryptEnvelope("room_abc", key, event);
    expect(EncryptedEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });

  it("rejects invalid replay headers", () => {
    const base = { room_id: "r", iv: "iv", ciphertext: "ct" };
    expect(
      EncryptedEnvelopeSchema.safeParse({ ...base, sender: "", seq: 1 }).success,
    ).toBe(false);
    expect(
      EncryptedEnvelopeSchema.safeParse({ ...base, sender: "s", seq: -1 }).success,
    ).toBe(false);
    expect(
      EncryptedEnvelopeSchema.safeParse({ ...base, sender: "s", seq: 1.5 }).success,
    ).toBe(false);
    expect(
      EncryptedEnvelopeSchema.safeParse({ ...base, sender: "s", seq: 0 }).success,
    ).toBe(true);
  });

  it("attaches the underlying error as cause for diagnostics", async () => {
    const key = await generateSessionKey();
    const other = await generateSessionKey();
    const envelope = await encryptEnvelope("room_abc", key, event);
    let caught: unknown;
    try {
      await decryptEnvelope(other, envelope);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EnvelopeError);
    const envelopeError = caught as EnvelopeError;
    expect(envelopeError.reason).toBe("decryption_failed");
    expect(envelopeError.cause).toBeInstanceOf(Error);
  });

  it("attaches a zod cause when the envelope is malformed", async () => {
    let caught: unknown;
    try {
      await decryptEnvelope(await generateSessionKey(), { room_id: "" } as never);
    } catch (err) {
      caught = err;
    }
    expect((caught as EnvelopeError).reason).toBe("malformed_envelope");
    expect((caught as EnvelopeError).cause).toBeDefined();
  });
});
