import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WireEvent } from "@cadence/protocol";
import { AgentSession } from "../src/session.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

class FakeSocket {
  sent: WireEvent[] = [];
  handler: ((event: WireEvent) => void) | undefined;
  onEvent(handler: (event: WireEvent) => void): void {
    this.handler = handler;
  }
  async send(event: WireEvent): Promise<void> {
    this.sent.push(event);
  }
  last(): WireEvent | undefined {
    return this.sent[this.sent.length - 1];
  }
  async all(count: number, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (this.sent.length < count) {
      if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for events");
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

function stubAgent(dir: string, body: string): string {
  const path = join(dir, "stub-agent.sh");
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("AgentSession", () => {
  it("forwards ordinary output as TERMINAL_DATA", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-sess-"));
    const agent = stubAgent(dir, 'printf "working..."');
    const socket = new FakeSocket();
    const session = new AgentSession({
      agent: "claude",
      command: "bash",
      args: [agent],
      cwd: dir,
      socket: socket as never,
      sessionId: "sess_1",
      config: { safeCommands: [] },
    });
    session.start();
    await socket.all(1);
    expect(socket.sent[0].event).toBe("TERMINAL_DATA");
    session.stop();
  });

  it("intercepts a confirmation and auto-approves safe commands", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-sess-"));
    const agent = stubAgent(
      dir,
      'printf "npm test\\nDo you want to proceed? [y/N]"; read -n 1; printf " done"',
    );
    const socket = new FakeSocket();
    const session = new AgentSession({
      agent: "claude",
      command: "bash",
      args: [agent],
      cwd: dir,
      socket: socket as never,
      sessionId: "sess_1",
      config: { safeCommands: ["npm test"] },
    });
    session.start();
    await socket.all(1);
    // The intercept hit was safe-listed: only the TERMINAL_DATA went out,
    // the approval keystroke was written straight into the PTY, and the
    // post-approval output arrives.
    expect(socket.sent.every((e) => e.event === "TERMINAL_DATA")).toBe(true);
    const chunks = socket.sent
      .map((e) => (e.payload as { chunk: string }).chunk)
      .join("");
    expect(chunks).toContain(" done");
    session.stop();
  });

  it("raises INTERCEPT_REQUIRED for unsafe commands and resumes on APPROVE", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-sess-"));
    const agent = stubAgent(
      dir,
      'printf "rm -rf ./dist && npm run build\\nDo you want to proceed? [y/N]"; read -n 1; printf " continued"',
    );
    const socket = new FakeSocket();
    const session = new AgentSession({
      agent: "claude",
      command: "bash",
      args: [agent],
      cwd: dir,
      socket: socket as never,
      sessionId: "sess_1",
      config: { safeCommands: [] },
    });
    session.start();
    await socket.all(1);
    const intercept = socket.sent.find((e) => e.event === "INTERCEPT_REQUIRED");
    expect(intercept).toBeDefined();
    expect((intercept!.payload as { command: string }).command).toBe(
      "rm -rf ./dist && npm run build",
    );

    // Mobile approves; the y keystroke resumes the agent.
    socket.handler!({
      event: "RESOLVE_INTERCEPT",
      meta: { session_id: "sess_1" },
      payload: { decision: "APPROVE", input_payload: null },
    } as WireEvent);
    await socket.all(3);
    const resumed = socket.sent
      .map((e) => (e.payload as { chunk: string }).chunk)
      .join("");
    expect(resumed).toContain(" continued");
    session.stop();
  });

  it("writes EXECUTE_AGENT_PROMPT input into the pty", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-sess-"));
    const agent = stubAgent(dir, 'read line; printf "prompted:%s" "$line"');
    const socket = new FakeSocket();
    const session = new AgentSession({
      agent: "claude",
      command: "bash",
      args: [agent],
      cwd: dir,
      socket: socket as never,
      sessionId: "sess_1",
      config: { safeCommands: [] },
    });
    session.start();
    await new Promise((r) => setTimeout(r, 300));
    socket.handler!({
      event: "EXECUTE_AGENT_PROMPT",
      meta: { session_id: "sess_1" },
      payload: { prompt: "list the src dir" },
    } as WireEvent);
    await socket.all(1);
    const chunks = socket.sent
      .map((e) => (e.payload as { chunk: string }).chunk)
      .join("");
    expect(chunks).toContain("prompted:list the src dir");
    session.stop();
  });
});
