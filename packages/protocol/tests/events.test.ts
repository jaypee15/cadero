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
});
