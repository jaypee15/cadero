// packages/protocol/tests/events.test.ts
import { describe, expect, it } from "vitest";
import { WireEventSchema } from "../src/events.js";

describe("wire event schema rejections", () => {
  it("rejects a bad agent enum in INTERCEPT_REQUIRED", () => {
    const result = WireEventSchema.safeParse({
      event: "INTERCEPT_REQUIRED",
      meta: { session_id: "s" },
      payload: { agent: "gemini", reason: "EXECUTE_COMMAND", command: "ls" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty prompt in EXECUTE_AGENT_PROMPT", () => {
    const result = WireEventSchema.safeParse({
      event: "EXECUTE_AGENT_PROMPT",
      meta: { session_id: "s" },
      payload: { prompt: "" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty reason in SESSION_ENDED", () => {
    const result = WireEventSchema.safeParse({
      event: "SESSION_ENDED",
      meta: { session_id: "s" },
      payload: { code: 0, reason: "" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a bad timestamp in meta", () => {
    const result = WireEventSchema.safeParse({
      event: "HEARTBEAT",
      meta: { session_id: "s", timestamp: -1 },
      payload: {},
    });
    expect(result.success).toBe(false);
    const fractional = WireEventSchema.safeParse({
      event: "HEARTBEAT",
      meta: { session_id: "s", timestamp: 1.5 },
      payload: {},
    });
    expect(fractional.success).toBe(false);
  });

  it("rejects an empty session_id in meta", () => {
    const result = WireEventSchema.safeParse({
      event: "HEARTBEAT",
      meta: { session_id: "" },
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown event types", () => {
    const result = WireEventSchema.safeParse({
      event: "SOMETHING_ELSE",
      meta: { session_id: "s" },
      payload: {},
    });
    expect(result.success).toBe(false);
  });
});
