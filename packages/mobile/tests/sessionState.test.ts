import { describe, expect, it } from "vitest";
import { GAP_MARKER, reduceSession, type SessionState } from "../src/state/sessionState.js";

const initial: SessionState = {
  phase: "connecting",
  intercept: null,
  gapped: false,
  chunkCount: 0,
};

describe("reduceSession", () => {
  it("counts terminal chunks", () => {
    const next = reduceSession(initial, {
      type: "EVENT",
      event: { event: "TERMINAL_DATA", meta: { session_id: "s" }, payload: { chunk: "x" } },
    });
    expect(next.chunkCount).toBe(1);
  });

  it("raises an intercept and clears it on resolve", () => {
    const raised = reduceSession(initial, {
      type: "EVENT",
      event: {
        event: "INTERCEPT_REQUIRED",
        meta: { session_id: "sess_1", timestamp: 42 },
        payload: { agent: "claude", reason: "EXECUTE_COMMAND", command: "rm -rf ./dist" },
      },
    });
    expect(raised.intercept).toEqual({
      id: "sess_1:42",
      agent: "claude",
      command: "rm -rf ./dist",
    });
    expect(reduceSession(raised, { type: "RESOLVED" }).intercept).toBeNull();
  });

  it("ignores mobile-direction events", () => {
    const next = reduceSession(initial, {
      type: "EVENT",
      event: {
        event: "RESOLVE_INTERCEPT",
        meta: { session_id: "s" },
        payload: { decision: "APPROVE", input_payload: null },
      },
    });
    expect(next).toEqual(initial);
  });

  it("marks gaps and closes on close/fatal", () => {
    expect(reduceSession(initial, { type: "GAP" }).gapped).toBe(true);
    const closed = reduceSession(initial, { type: "CLOSED", code: 4404, reason: "unknown room" });
    expect(closed.phase).toBe("closed");
    expect(closed.closedReason).toContain("4404");
    const fatal = reduceSession(initial, { type: "FATAL", message: "wrong key" });
    expect(fatal.phase).toBe("closed");
    expect(fatal.closedReason).toContain("wrong key");
  });

  it("clears the gap marker when data flows again", () => {
    const gapped = reduceSession(initial, { type: "GAP" });
    expect(gapped.gapped).toBe(true);
    const recovered = reduceSession(gapped, {
      type: "EVENT",
      event: { event: "TERMINAL_DATA", meta: { session_id: "s" }, payload: { chunk: "back" } },
    });
    expect(recovered.gapped).toBe(false);
  });

  it("exposes the gap marker constant", () => {
    expect(GAP_MARKER).toContain("output during the gap was not captured");
  });

  it("closes on SESSION_ENDED with the agent's reason", () => {
    const closed = reduceSession(initial, {
      type: "EVENT",
      event: {
        event: "SESSION_ENDED",
        meta: { session_id: "s" },
        payload: { code: 1, reason: "agent exited with code 1" },
      },
    });
    expect(closed.phase).toBe("closed");
    expect(closed.closedReason).toContain("agent exited with code 1");
  });
});
