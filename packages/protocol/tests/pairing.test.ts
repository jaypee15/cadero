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

  it("parses the compact payload form", async () => {
    const key = await exportSessionKey(await generateSessionKey());
    const payload = `cadero://p?r=${encodeURIComponent("https://relay.example.com")}&m=room_abc123def4567890&k=${key}`;
    const parsed = parsePairingPayload(payload);
    expect(parsed).toEqual({
      relay: "https://relay.example.com",
      room: "room_abc123def4567890",
      key,
    });
  });

  it("parses a compact payload with a bare host as https", async () => {
    const key = await exportSessionKey(await generateSessionKey());
    const payload = `cadero://p?r=cadero.dev&m=room_abc123def4567890&k=${key}`;
    const parsed = parsePairingPayload(payload);
    expect(parsed.relay).toBe("https://cadero.dev");
    expect(parsed.room).toBe("room_abc123def4567890");
    expect(parsed.key).toBe(key);
  });

  it("keeps an explicit http scheme when given in the compact form", async () => {
    const key = await exportSessionKey(await generateSessionKey());
    const payload = `cadero://p?r=${encodeURIComponent("http://localhost:8787")}&m=room_abc123def4567890&k=${key}`;
    expect(parsePairingPayload(payload).relay).toBe("http://localhost:8787");
  });

  it("rejects a compact payload with a malformed key", async () => {
    const payload = "cadero://p?r=https%3A%2F%2Fr.example.com&m=room_abc123def4567890&k=nope";
    expect(() => parsePairingPayload(payload)).toThrow("not a cadero pairing payload");
  });

  it("accepts the compact form of every documented variant", () => {
    // scheme/host must be exact; params missing → rejected
    expect(() => parsePairingPayload("cadero://p?r=x&m=room_abc123def4567890")).toThrow(
      "not a cadero pairing payload",
    );
  });

  it("parses an optional session label from the compact form", async () => {
    const key = await exportSessionKey(await generateSessionKey());
    const payload = `cadero://p?r=cadero.dev&m=room_abc123def4567890&k=${key}&l=${encodeURIComponent("claude · cadence")}`;
    const parsed = parsePairingPayload(payload);
    expect(parsed.label).toBe("claude · cadence");
    expect(parsed.relay).toBe("https://cadero.dev");
  });

  it("omits the label field entirely when absent (back-compat)", async () => {
    const key = await exportSessionKey(await generateSessionKey());
    const payload = `cadero://p?r=cadero.dev&m=room_abc123def4567890&k=${key}`;
    const parsed = parsePairingPayload(payload);
    expect("label" in parsed).toBe(false);
  });

  it("rejects an over-long label", async () => {
    const key = await exportSessionKey(await generateSessionKey());
    const payload = `cadero://p?r=cadero.dev&m=room_abc123def4567890&k=${key}&l=${encodeURIComponent("x".repeat(65))}`;
    expect(() => parsePairingPayload(payload)).toThrow("not a cadero pairing payload");
  });
});
