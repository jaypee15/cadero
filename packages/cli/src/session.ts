import type { WireEvent } from "@cadero/protocol";
import { createPtySession, type PtySession } from "./pty.js";
import { findIntercept, isSafeCommand, type AgentName } from "./intercept.js";

/** Spec §6: an intercept with no mobile response is denied after 15 minutes. */
export const INTERCEPT_TIMEOUT_MS = 900000;

export interface AgentSessionOptions {
  agent: AgentName;
  command: string;
  args?: string[];
  cwd: string;
  socket: Pick<import("./socket.js").CaderoSocket, "send"> & {
    onEvent(handler: (event: WireEvent) => void): void;
  };
  sessionId: string;
  config: { safeCommands: string[] };
  autoApproveText?: string;
  interceptTimeoutMs?: number;
  onError?: (message: string) => void;
  /** Mirror every PTY chunk to the operator's terminal. */
  onLocalOutput?: (chunk: string) => void;
  /** Called once after the agent exits and the final frames are sent. */
  onEnd?: (code: number) => void;
}

export class AgentSession {
  // A PTY chunk boundary can split a prompt line in half; prompts must be
  // detected across chunks, so incoming output is accumulated here. The
  // buffer never contains a "\n" (complete lines are forwarded promptly).
  private static readonly MAX_HELD_LINE = 8192;
  private readonly opts: AgentSessionOptions;
  private pty: PtySession | undefined;
  private pending: { command: string; approveInput?: string } | undefined;
  private buffer = "";
  private lineBuffer = "";
  private prevLine = "";
  private timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: AgentSessionOptions) {
    this.opts = opts;
  }

  start(): void {
    this.pty = createPtySession({
      command: this.opts.command,
      args: this.opts.args,
      cwd: this.opts.cwd,
    });
    this.pty.onData((chunk) => {
      // The operator at the terminal sees exactly what the phone sees.
      this.opts.onLocalOutput?.(chunk);
      this.handleChunk(chunk);
    });
    this.pty.onExit((code) => this.handleExit(code));
    this.opts.socket.onEvent((event) => this.handleRemote(event));
  }

  stop(): void {
    this.clearInterceptTimeout();
    this.pty?.kill();
    this.pty = undefined;
  }

  private handleChunk(chunk: string): void {
    if (this.pending) {
      this.buffer += chunk;
      return; // stream paused behind the pending intercept
    }
    const unforwarded = this.lineBuffer + chunk;
    const prefix = this.prevLine ? `${this.prevLine}\n` : "";
    const window = prefix + unforwarded;
    const hit = findIntercept(this.opts.agent, window);
    if (hit) {
      this.lineBuffer = "";
      this.prevLine = "";
      if (isSafeCommand(hit.command, this.opts.config.safeCommands)) {
        this.pty?.write(hit.approveInput ?? this.opts.autoApproveText ?? "y\r");
        this.sendTerminal(unforwarded);
        return;
      }
      this.pending = { command: hit.command, approveInput: hit.approveInput };
      this.armInterceptTimeout();
      // Flush everything up to and including the matched prompt; anything
      // after it waits behind the pending intercept.
      const matchStart = Math.max(0, hit.end - prefix.length);
      const matched = unforwarded.slice(0, matchStart);
      this.buffer = unforwarded.slice(matchStart);
      if (matched.length > 0) this.sendTerminal(matched);
      this.trySend({
        event: "INTERCEPT_REQUIRED",
        meta: { session_id: this.opts.sessionId },
        payload: {
          agent: this.opts.agent,
          reason: "EXECUTE_COMMAND",
          command: hit.command,
        },
      });
      return;
    }
    const nl = unforwarded.lastIndexOf("\n");
    if (nl >= 0) {
      const complete = unforwarded.slice(0, nl + 1);
      this.sendTerminal(complete);
      const head = complete.slice(0, -1);
      const prevNl = head.lastIndexOf("\n");
      this.prevLine = prevNl >= 0 ? head.slice(prevNl + 1) : head;
      this.lineBuffer = unforwarded.slice(nl + 1);
    } else if (unforwarded.length > AgentSession.MAX_HELD_LINE) {
      // Pathological newline-free stream: flush the overflow so terminal
      // output still streams, keep a bounded context window for detection.
      const held = unforwarded.slice(unforwarded.length - AgentSession.MAX_HELD_LINE);
      this.sendTerminal(unforwarded.slice(0, unforwarded.length - AgentSession.MAX_HELD_LINE));
      this.lineBuffer = held;
    } else {
      this.lineBuffer = unforwarded;
    }
  }

  private handleRemote(event: WireEvent): void {
    if (event.event === "RESOLVE_INTERCEPT") {
      if (!this.pending) return; // stray resolution: nothing to resolve
      this.clearInterceptTimeout();
      if (event.payload.decision === "APPROVE") {
        this.pty?.write(event.payload.input_payload ?? this.pending.approveInput ?? "y\r");
      } else {
        this.pty?.write("\u001b");
      }
      const flushed = this.buffer;
      this.buffer = "";
      this.pending = undefined;
      if (flushed.length > 0) {
        this.sendTerminal(flushed);
      }
      return;
    }
    if (event.event === "EXECUTE_AGENT_PROMPT") {
      this.pty?.write(`${event.payload.prompt}\r`);
    }
  }

  private handleExit(code: number): void {
    const tail = this.lineBuffer;
    this.lineBuffer = "";
    if (tail.length > 0) this.sendTerminal(tail);
    if (this.pending) {
      this.clearInterceptTimeout();
      const flushed = this.buffer;
      this.buffer = "";
      this.pending = undefined;
      if (flushed.length > 0) this.sendTerminal(flushed);
    }
    this.sendTerminal(`\n[session exited with code ${code}]\n`);
    // Tell the phone the session is over (it reacts with a closed screen and
    // stops reconnecting), then tear down this side as well.
    this.trySend({
      event: "SESSION_ENDED",
      meta: { session_id: this.opts.sessionId },
      payload: { code, reason: `agent exited with code ${code}` },
    });
    this.opts.onEnd?.(code);
    const socket = this.opts.socket as { close?: () => void };
    if (typeof socket.close === "function") void socket.close();
    this.pty = undefined;
  }

  private armInterceptTimeout(): void {
    const ms = this.opts.interceptTimeoutMs ?? INTERCEPT_TIMEOUT_MS;
    this.timeoutTimer = setTimeout(() => {
      void (async () => {
        if (!this.pending) return;
        this.clearInterceptTimeout();
        this.pending = undefined;
        this.pty?.write("\u001b");
        const seconds = Math.round(ms / 1000);
        await this.trySend({
          event: "TERMINAL_DATA",
          meta: { session_id: this.opts.sessionId },
          payload: {
            chunk: `\n[intercept timed out after ${seconds}s; command denied — session ending]\n`,
          },
        });
        this.opts.onError?.("intercept timed out; command denied; session ending");
        const socket = this.opts.socket as { close?: () => void };
        if (typeof socket.close === "function") socket.close();
        this.stop();
      })();
    }, ms);
  }

  private clearInterceptTimeout(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
  }

  private trySend(event: WireEvent): void {
    this.opts.socket.send(event).catch((err: unknown) => {
      // Frames produced while the relay is reconnecting are dropped (spec §6).
      // The send failure must never crash the daemon or disturb the backoff.
      this.opts.onError?.(
        `dropped ${event.event} frame while relay reconnecting: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  private sendTerminal(chunk: string): void {
    this.trySend({
      event: "TERMINAL_DATA",
      meta: { session_id: this.opts.sessionId },
      payload: { chunk },
    });
  }
}
