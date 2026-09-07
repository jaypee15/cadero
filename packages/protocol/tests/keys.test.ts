import { describe, expect, it } from "vitest";
import {
  decryptEnvelope,
  encryptEnvelope,
  encryptRaw,
  EnvelopeError,
  exportSessionKey,
  generateSessionKey,
  importSessionKey,
} from "../src/index.js";

const event = {
  event: "TERMINAL_DATA",
  meta: { session_id: "sess_1" },
  payload: { chunk: "hello" },
} as const;

describe("session key helpers", () => {
  it("round-trips a key through export and import", async () => {
    const key = await generateSessionKey();
    const raw = await exportSessionKey(key);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const imported = await importSessionKey(raw);
    const envelope = await encryptEnvelope("room_1", imported, event);
    const back = await decryptEnvelope(imported, envelope);
    expect(back).toEqual(event);
  });
});

describe("EnvelopeError", () => {
  it("reports decryption_failed for a wrong key", async () => {
    const key = await generateSessionKey();
    const other = await generateSessionKey();
    const envelope = await encryptEnvelope("room_1", key, event);
    try {
      await decryptEnvelope(other, envelope);
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeError);
      expect((err as EnvelopeError).reason).toBe("decryption_failed");
    }
  });

  it("reports malformed_envelope for a bad shape", async () => {
    const key = await generateSessionKey();
    try {
      await decryptEnvelope(key, { room_id: "room_1", iv: "", ciphertext: "" });
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeError);
      expect((err as EnvelopeError).reason).toBe("malformed_envelope");
    }
  });

  it("reports invalid_event for undecryptable JSON payload", async () => {
    const key = await generateSessionKey();
    const envelope = await encryptEnvelope("room_1", key, event);
    const tampered = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -4) + "AAAA" };
    try {
      await decryptEnvelope(key, tampered);
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeError);
      expect((err as EnvelopeError).reason).toBe("decryption_failed");
    }
  });

  it("reports invalid_event when plaintext is not a wire event", async () => {
    const key = await generateSessionKey();
    const env = await encryptRaw("room_1", key, JSON.stringify({ nope: true }));
    try {
      await decryptEnvelope(key, env);
      expect.unreachable("expected rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(EnvelopeError);
      expect((err as EnvelopeError).reason).toBe("invalid_event");
    }
  });
});
