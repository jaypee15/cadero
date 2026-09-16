// packages/relay/tests/logging.test.ts
import { describe, expect, it } from "vitest";
import { redactForLog } from "../src/logging.js";

describe("redactForLog", () => {
  it("never echoes non-object values", () => {
    expect(redactForLog("raw text")).toBe("[redacted]");
    expect(redactForLog(42)).toBe("[redacted]");
    expect(redactForLog(null)).toBe("[redacted]");
    expect(redactForLog(undefined)).toBe("[redacted]");
  });

  it("falls back to unknown when room_id is missing", () => {
    expect(redactForLog({})).toBe("dropped frame in unknown [body redacted]");
    expect(redactForLog({ room_id: 42 })).toBe("dropped frame in unknown [body redacted]");
  });

  it("names the room but redacts the body", () => {
    expect(redactForLog({ room_id: "room_abc", iv: "secret" })).toBe(
      "dropped frame in room_abc [body redacted]",
    );
  });
});
