// packages/protocol/tests/events.test.ts
import { describe, expect, it } from "vitest";
import { WireEventSchema } from "../src/events.js";

describe("WireEventSchema", () => {
  it("accepts a TERMINAL_DATA event", () => {
    const parsed = WireEventSchema.safeParse({
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_91823", timestamp: 1714838400 },
      payload: { chunk: "hello" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown event name", () => {
    const parsed = WireEventSchema.safeParse({
      event: "RUN_ANYTHING",
      meta: { session_id: "sess_91823" },
      payload: {},
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects RESOLVE_INTERCEPT with a bad decision", () => {
    const parsed = WireEventSchema.safeParse({
      event: "RESOLVE_INTERCEPT",
      meta: { session_id: "sess_91823" },
      payload: { decision: "MAYBE", input_payload: null },
    });
      expect(parsed.success).toBe(false);
  });

  it("accepts a HEARTBEAT event and rejects one with a payload", () => {
    expect(
      WireEventSchema.safeParse({
        event: "HEARTBEAT",
        meta: { session_id: "sess_1" },
        payload: {},
      }).success,
    ).toBe(true);
    expect(
      WireEventSchema.safeParse({
        event: "HEARTBEAT",
        meta: { session_id: "sess_1" },
        payload: { chunk: "nope" },
      }).success,
    ).toBe(false);
  });

  it("accepts SESSION_ENDED with a code and reason", () => {
    const parsed = WireEventSchema.safeParse({
      event: "SESSION_ENDED",
      meta: { session_id: "sess_91823" },
      payload: { code: 1, reason: "agent exited with code 1" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects SESSION_ENDED with a non-numeric code", () => {
    const parsed = WireEventSchema.safeParse({
      event: "SESSION_ENDED",
      meta: { session_id: "sess_91823" },
      payload: { code: "one", reason: "agent exited" },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts TERMINAL_RESIZE with sane dimensions and rejects absurd ones", () => {
    expect(
      WireEventSchema.safeParse({
        event: "TERMINAL_RESIZE",
        meta: { session_id: "sess_1" },
        payload: { cols: 50, rows: 24 },
      }).success,
    ).toBe(true);
    expect(
      WireEventSchema.safeParse({
        event: "TERMINAL_RESIZE",
        meta: { session_id: "sess_1" },
        payload: { cols: 99999, rows: 1 },
      }).success,
    ).toBe(false);
  });

  it("accepts INTERCEPT_REQUIRED for every supported agent", () => {
    for (const agent of ["claude", "opencode", "codex"] as const) {
      expect(
        WireEventSchema.safeParse({
          event: "INTERCEPT_REQUIRED",
          meta: { session_id: "sess_1" },
          payload: { agent, reason: "EXECUTE_COMMAND", command: "npm test" },
        }).success,
      ).toBe(true);
    }
    expect(
      WireEventSchema.safeParse({
        event: "INTERCEPT_REQUIRED",
        meta: { session_id: "sess_1" },
        payload: { agent: "gemini", reason: "EXECUTE_COMMAND", command: "x" },
      }).success,
    ).toBe(false);
  });
});
