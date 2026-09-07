import type { WireEvent } from "@cadence/protocol";
import { createPtySession, type PtySession } from "./pty.js";
import { detectIntercept, isSafeCommand, type AgentName } from "./intercept.js";

export interface AgentSessionOptions {
  agent: AgentName;
  command: string;
  args?: string[];
  cwd: string;
  socket: Pick<import("./socket.js").CadenceSocket, "send"> & {
    onEvent(handler: (event: WireEvent) => void): void;
  };
  sessionId: string;
  config: { safeCommands: string[] };
  autoApproveText?: string;
  onError?: (message: string) => void;
}

export class AgentSession {
  private readonly opts: AgentSessionOptions;
  private pty: PtySession | undefined;
  private pending: { command: string } | undefined;
  private buffer = "";

  constructor(opts: AgentSessionOptions) {
    this.opts = opts;
  }

  start(): void {
    this.pty = createPtySession({
      command: this.opts.command,
      args: this.opts.args,
      cwd: this.opts.cwd,
    });
    this.pty.onData((chunk) => this.handleChunk(chunk));
    this.pty.onExit((code) => this.handleExit(code));
    this.opts.socket.onEvent((event) => this.handleRemote(event));
  }

  stop(): void {
    this.pty?.kill();
    this.pty = undefined;
  }

  private handleChunk(chunk: string): void {
    if (this.pending) {
      this.buffer += chunk;
      return; // stream paused behind the pending intercept
    }
    const hit = detectIntercept(this.opts.agent, chunk);
    if (hit) {
      if (isSafeCommand(hit.command, this.opts.config.safeCommands)) {
        this.pty?.write(this.opts.autoApproveText ?? "y\r");
        this.sendTerminal(chunk);
        return;
      }
      this.pending = hit;
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
    this.sendTerminal(chunk);
  }

  private handleRemote(event: WireEvent): void {
    if (event.event === "RESOLVE_INTERCEPT") {
      if (event.payload.decision === "APPROVE") {
        this.pty?.write(event.payload.input_payload ?? "y\r");
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
    this.sendTerminal(`\n[session exited with code ${code}]\n`);
    this.pty = undefined;
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
