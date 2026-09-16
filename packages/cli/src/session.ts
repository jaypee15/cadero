import type { WireEvent } from "@cadero/protocol";
import { createPtySession, type PtySession } from "./pty.js";
import { findIntercept, isSafeCommand, type AgentName } from "./intercept.js";

/** Spec §6: an intercept with no mobile response is denied after 15 minutes. */
export const INTERCEPT_TIMEOUT_MS = 900000;

/**
 * A pending INTERCEPT_REQUIRED raised before any phone joins the room is
 * unrecoverable otherwise (the relay replays nothing), so it is re-sent
 * periodically until resolved.
 */
export const INTERCEPT_REEMIT_MS = 3000;

export interface AgentSessionOptions {
  agent: AgentName;
  command: string;
  args?: string[];
  cwd: string;
  /** Initial PTY dimensions (default: the invoking terminal's size). */
  cols?: number;
  rows?: number;
  socket: Pick<import("./socket.js").CaderoSocket, "send" | "close"> & {
    onEvent(handler: (event: WireEvent) => void): void;
  };
  sessionId: string;
  config: { safeCommands: string[] };
  autoApproveText?: string;
  interceptTimeoutMs?: number;
  interceptReEmitMs?: number;
  onError?: (message: string) => void;
  /** Mirror every PTY chunk to the operator's terminal. */
  onLocalOutput?: (chunk: string) => void;
  /** Fired on the first TERMINAL_RESIZE: a phone has joined the room. */
  onPhoneJoined?: () => void;
  /** Called once after the agent exits and the final frames are sent. */
  onEnd?: (code: number) => void;
}

export class AgentSession {
  // A PTY chunk boundary can split a prompt line in half; prompts must be
  // detected across chunks, so incoming output is accumulated here. The
  // buffer never contains a "\n" (complete lines are forwarded promptly).
  private static readonly MAX_HELD_LINE = 8192;
  // Detection window: the last ~800 chars of streamed output. Multi-line
  // dialogs (opencode's permission block) span several streamed lines, so
  // detection needs context beyond a single line.
  private static readonly MAX_WINDOW = 800;
  private readonly opts: AgentSessionOptions;
  private pty: PtySession | undefined;
  private pending: { command: string; approveInput?: string } | undefined;
  private buffer = "";
  private lineBuffer = "";
  private prevLine = "";
  private recent = "";
  private timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  private reemitTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: AgentSessionOptions) {
    this.opts = opts;
  }

  start(): void {
    this.pty = createPtySession({
      command: this.opts.command,
      args: this.opts.args,
      cwd: this.opts.cwd,
      cols: this.opts.cols,
      rows: this.opts.rows,
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
    this.clearInterceptTimers();
    this.pty?.kill();
    this.pty = undefined;
  }

  private handleChunk(chunk: string): void {
    // Multi-line dialogs (opencode's permission block) span several lines,
    // and complete lines stream out immediately — so detection runs on a
    // rolling window of recent FORWARDED output plus the current line.
    const unforwarded = this.lineBuffer + chunk;
    const hit = findIntercept(this.opts.agent, this.recent + unforwarded);
    if (hit) {
      this.recent = "";
      this.lineBuffer = "";
      this.prevLine = "";
      if (isSafeCommand(hit.command, this.opts.config.safeCommands)) {
        void this.writeApproval(hit.approveInput ?? this.opts.autoApproveText ?? "y\r");
        this.sendTerminal(unforwarded);
        return;
      }
      this.pending = { command: hit.command, approveInput: hit.approveInput };
      this.armInterceptTimers();
      if (unforwarded.length > 0) this.sendTerminal(unforwarded);
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
      // The detection window accumulates only FORWARDED text; the held
      // partial stays solely in lineBuffer so it is never double-counted.
      this.recent = (this.recent + complete).slice(-AgentSession.MAX_WINDOW);
      const head = complete.slice(0, -1);
      const prevNl = head.lastIndexOf("\n");
      this.prevLine = prevNl >= 0 ? head.slice(prevNl + 1) : head;
      this.lineBuffer = unforwarded.slice(nl + 1);
    } else if (unforwarded.length > AgentSession.MAX_HELD_LINE) {
      // Pathological newline-free stream: flush the overflow so terminal
      // output still streams, keep a bounded context window for detection.
      const forwarded = unforwarded.slice(0, unforwarded.length - AgentSession.MAX_HELD_LINE);
      this.sendTerminal(forwarded);
      this.recent = (this.recent + forwarded).slice(-AgentSession.MAX_WINDOW);
      this.lineBuffer = unforwarded.slice(unforwarded.length - AgentSession.MAX_HELD_LINE);
    } else {
      this.lineBuffer = unforwarded;
    }
  }

  private async handleRemote(event: WireEvent): Promise<void> {
    if (event.event === "RESOLVE_INTERCEPT") {
      if (!this.pending) return; // stray resolution: nothing to resolve
      this.clearInterceptTimers();
      const pending = this.pending;
      this.pending = undefined;
      if (event.payload.decision === "APPROVE") {
        await this.writeApproval(
          event.payload.input_payload ?? pending.approveInput ?? "y\r",
        );
      } else {
        this.pty?.write("\u001b");
      }
      const flushed = this.buffer;
      this.buffer = "";
      if (flushed.length > 0) {
        this.sendTerminal(flushed);
      }
      return;
    }
    if (event.event === "TERMINAL_RESIZE") {
      // The phone's terminal is now the authoritative viewport: the agent
      // gets SIGWINCH and redraws its TUI to fit the phone. The first of
      // these is also the reliable "a phone joined" signal.
      this.opts.onPhoneJoined?.();
      this.pty?.resize(event.payload.cols, event.payload.rows);
      return;
    }
    if (event.event === "EXECUTE_AGENT_PROMPT") {
      this.pty?.write(`${event.payload.prompt}\r`);
    }
  }

  private async writeApproval(input: string): Promise<void> {
    // Multi-keystroke approvals (e.g. "arrow-down|Enter" for selection
    // dialogs) are written with a gap: TUIs discard input that arrives in
    // the same buffer as the keystroke they redraw after.
    const parts = input.split("|");
    for (const [index, part] of parts.entries()) {
      this.pty?.write(part);
      if (index < parts.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  private handleExit(code: number): void {
    const tail = this.lineBuffer;
    this.lineBuffer = "";
    if (tail.length > 0) this.sendTerminal(tail);
    if (this.pending) {
      this.clearInterceptTimers();
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

  private armInterceptTimers(): void {
    // Denial deadline (spec §6)…
    const ms = this.opts.interceptTimeoutMs ?? INTERCEPT_TIMEOUT_MS;
    this.timeoutTimer = setTimeout(() => {
      void (async () => {
        if (!this.pending) return;
        this.clearInterceptTimers();
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
        if (typeof socket.close === "function") void socket.close();
        this.stop();
      })();
    }, ms);
    // …and the periodic re-send that lets a late-joining phone see the
    // pending intercept (the relay replays nothing).
    const reemit = this.opts.interceptReEmitMs ?? INTERCEPT_REEMIT_MS;
    this.reemitTimer = setInterval(() => {
      if (!this.pending) {
        this.clearReEmitTimer();
        return;
      }
      this.trySend({
        event: "INTERCEPT_REQUIRED",
        meta: { session_id: this.opts.sessionId },
        payload: {
          agent: this.opts.agent,
          reason: "EXECUTE_COMMAND",
          command: this.pending.command,
        },
      });
    }, reemit);
  }

  private clearInterceptTimeout(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
  }

  private clearReEmitTimer(): void {
    if (this.reemitTimer) clearInterval(this.reemitTimer);
    this.reemitTimer = undefined;
  }

  private clearInterceptTimers(): void {
    this.clearInterceptTimeout();
    this.clearReEmitTimer();
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
