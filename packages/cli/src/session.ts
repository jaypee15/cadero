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
    this.pty.onData((chunk) => void this.handleChunk(chunk));
    this.pty.onExit((code) => void this.handleExit(code));
    this.opts.socket.onEvent((event) => void this.handleRemote(event));
  }

  stop(): void {
    this.pty?.kill();
    this.pty = undefined;
  }

  private async handleChunk(chunk: string): Promise<void> {
    if (this.pending) {
      this.buffer += chunk;
      return; // stream paused behind the pending intercept
    }
    const hit = detectIntercept(this.opts.agent, chunk);
    if (hit) {
      if (isSafeCommand(hit.command, this.opts.config.safeCommands)) {
        this.pty?.write(this.opts.autoApproveText ?? "y\r");
        await this.sendTerminal(chunk);
        return;
      }
      this.pending = hit;
      await this.opts.socket.send({
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
    await this.sendTerminal(chunk);
  }

  private async handleRemote(event: WireEvent): Promise<void> {
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
        await this.sendTerminal(flushed);
      }
      return;
    }
    if (event.event === "EXECUTE_AGENT_PROMPT") {
      this.pty?.write(`${event.payload.prompt}\r`);
    }
  }

  private async handleExit(code: number): Promise<void> {
    await this.sendTerminal(`\n[session exited with code ${code}]\n`);
    this.pty = undefined;
  }

  private sendTerminal(chunk: string): Promise<void> {
    return this.opts.socket.send({
      event: "TERMINAL_DATA",
      meta: { session_id: this.opts.sessionId },
      payload: { chunk },
    });
  }
}
