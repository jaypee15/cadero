import { describe, expect, it } from "vitest";
import {
  decryptEnvelope,
  encryptEnvelope,
  exportSessionKey,
  importSessionKey,
} from "@cadero/protocol";
import { pairSession, parsePairingPayload } from "../src/pairing.js";

describe("pairSession", () => {
  it("pairs via the relay and emits a parseable QR payload", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://relay.example.com/v1/pair");
      expect(init?.method).toBe("POST");
      const auth = new Headers(init?.headers).get("authorization");
      expect(auth).toBe("Bearer tok123");
      return new Response(JSON.stringify({ room_id: "room_abc123def4567890" }), {
        status: 200,
      });
    }) as typeof fetch;

    const { roomId, sessionKey, qrPayload } = await pairSession(
      "https://relay.example.com",
      "tok123",
      fetchImpl,
    );
    expect(roomId).toBe("room_abc123def4567890");
    const parsed = parsePairingPayload(qrPayload);
    expect(parsed.relay).toBe("https://relay.example.com");
    expect(parsed.room).toBe("room_abc123def4567890");
    // The QR key imports to a key that decrypts what the session key encrypts.
    const imported = await importSessionKey(parsed.key);
    expect(await exportSessionKey(imported)).toBe(parsed.key);
    const env = await encryptEnvelope(roomId, sessionKey, {
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_1" },
      payload: { chunk: "x" },
    });
    const back = await decryptEnvelope(imported, env);
    expect(back).toEqual({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_1" },
      payload: { chunk: "x" },
    });
  });

  it("fails loudly on an unauthorized pair with re-login guidance", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
      })) as typeof fetch;
    await expect(pairSession("https://relay.example.com", "bad", fetchImpl)).rejects.toThrow(
      "saved login was rejected (HTTP 401) — run: cadero-cli login",
    );
  });
});

describe("parsePairingPayload", () => {
  it("rejects foreign payloads", () => {
    expect(() => parsePairingPayload("https://example.com")).toThrow(
      "not a cadero pairing payload",
    );
  });
});
