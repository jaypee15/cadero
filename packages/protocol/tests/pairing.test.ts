import { describe, expect, it } from "vitest";
import { generateSessionKey, exportSessionKey, parsePairingPayload } from "../src/index.js";

describe("parsePairingPayload (protocol)", () => {
  it("parses a payload built from a real session key", async () => {
    const key = await exportSessionKey(await generateSessionKey());
    const payload = `cadero://pair?v=1&relay=${encodeURIComponent("https://relay.example.com")}&room=${encodeURIComponent("room_abc123def4567890")}&key=${key}`;
    const parsed = parsePairingPayload(payload);
    expect(parsed).toEqual({
      relay: "https://relay.example.com",
      room: "room_abc123def4567890",
      key,
    });
  });

  it("rejects a key that is not 43-char base64url", async () => {
    const payload =
      "cadero://pair?v=1&relay=https%3A%2F%2Fr.example.com&room=room_abc123def4567890&key=tooshort";
    expect(() => parsePairingPayload(payload)).toThrow("not a cadero pairing payload");
  });

  it("rejects wrong scheme, host, or version", () => {
    expect(() => parsePairingPayload("https://example.com")).toThrow(
      "not a cadero pairing payload",
    );
    expect(() => parsePairingPayload("cadero://pair?v=2&relay=x&room=y&key=z")).toThrow(
      "not a cadero pairing payload",
    );
  });
});
