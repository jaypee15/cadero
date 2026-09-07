import type { WireEvent } from "@cadence/protocol";

export type SessionPhase = "need-pairing" | "connecting" | "live" | "closed";

export const GAP_MARKER = "\n[connection lost — output during the gap was not captured]\n";

export interface InterceptState {
  id: string;
  agent: string;
  command: string;
}

export interface SessionState {
  phase: SessionPhase;
  intercept: InterceptState | null;
  gapped: boolean;
  chunkCount: number;
  closedReason?: string;
}

export type SessionAction =
  | { type: "PAIR_SCANNED" }
  | { type: "CONNECTED" }
  | { type: "EVENT"; event: WireEvent }
  | { type: "GAP" }
  | { type: "RESOLVED" }
  | { type: "CLOSED"; code: number; reason: string }
  | { type: "FATAL"; message: string };

export const initialSessionState: SessionState = {
  phase: "need-pairing",
  intercept: null,
  gapped: false,
  chunkCount: 0,
};

export function reduceSession(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "PAIR_SCANNED":
      return { ...state, phase: "connecting" };
    case "CONNECTED":
      return { ...state, phase: "live" };
    case "GAP":
      return { ...state, gapped: true };
    case "RESOLVED":
      return { ...state, intercept: null };
    case "CLOSED":
      return {
        ...state,
        phase: "closed",
        closedReason: `relay closed the session (${action.code} ${action.reason})`,
      };
    case "FATAL":
      return { ...state, phase: "closed", closedReason: action.message };
    case "EVENT": {
      const event = action.event;
      if (event.event === "TERMINAL_DATA") {
        // Data flowing again clears the gap banner; the loss itself is
        // recorded in the terminal feed (Task 9 writes the gap marker text).
        return { ...state, chunkCount: state.chunkCount + 1, gapped: false };
      }
      if (event.event === "INTERCEPT_REQUIRED") {
        return {
          ...state,
          intercept: {
            id: `${event.meta.session_id}:${event.meta.timestamp ?? 0}`,
            agent: event.payload.agent,
            command: event.payload.command,
          },
        };
      }
      return state; // mobile-direction events never arrive here
    }
  }
}
