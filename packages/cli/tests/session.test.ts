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
  joined(): string {
    return this.sent
      .map((e) => (e.payload as { chunk?: string }).chunk ?? "")
      .join("");
  }
  async all(count: number, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (this.sent.length < count) {
      if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for events");
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  async until(pred: (events: WireEvent[]) => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!pred(this.sent)) {
      if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for events");
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

class OfflineFirstSocket {
  sent: WireEvent[] = [];
  handler: ((event: WireEvent) => void) | undefined;
  offline = true;
  dropped: string[] = [];
  onEvent(handler: (event: WireEvent) => void): void {
    this.handler = handler;
  }
  async send(event: WireEvent): Promise<void> {
    if (this.offline) {
      this.dropped.push(event.event);
      throw new Error("socket is not open; frame dropped (no offline queue)");
    }
    this.sent.push(event);
  }
  joined(): string {
    return this.sent
      .map((e) => (e.payload as { chunk?: string }).chunk ?? "")
      .join("");
  }
  async until(pred: (socket: OfflineFirstSocket) => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!pred(this)) {
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
    await socket.until((sent) => socket.joined().includes(" done"));
    // The intercept hit was safe-listed: only the TERMINAL_DATA went out,
    // the approval keystroke was written straight into the PTY, and the
    // post-approval output arrives.
    expect(socket.sent.every((e) => e.event === "TERMINAL_DATA")).toBe(true);
    const chunks = socket.joined();
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
    await socket.until(
      (sent) => sent.some((e) => e.event === "INTERCEPT_REQUIRED"),
    );
    const intercept = socket.sent.find((e) => e.event === "INTERCEPT_REQUIRED");
    expect((intercept!.payload as { command: string }).command).toBe(
      "rm -rf ./dist && npm run build",
    );

    // Mobile approves; the y keystroke resumes the agent.
    socket.handler!({
      event: "RESOLVE_INTERCEPT",
      meta: { session_id: "sess_1" },
      payload: { decision: "APPROVE", input_payload: null },
    } as WireEvent);
    await socket.until((sent) => socket.joined().includes(" continued"));
    const resumed = socket.joined();
    expect(resumed).toContain(" continued");
    session.stop();
  });

  it("detects a prompt line split across pty chunks", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-sess-"));
    const agent = stubAgent(
      dir,
      'printf "rm -rf ./dist\\nDo you want to "; sleep 0.2; printf "proceed? [y/N]"; read -n 1; printf " resumed"',
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
    // The command line streams out before the prompt finishes arriving.
    await socket.until(() => socket.joined().includes("rm -rf ./dist\r\n"));
    await socket.until(
      (sent) => sent.some((e) => e.event === "INTERCEPT_REQUIRED"),
    );
    const intercept = socket.sent.find((e) => e.event === "INTERCEPT_REQUIRED");
    expect((intercept!.payload as { command: string }).command).toBe(
      "rm -rf ./dist",
    );

    socket.handler!({
      event: "RESOLVE_INTERCEPT",
      meta: { session_id: "sess_1" },
      payload: { decision: "APPROVE", input_payload: null },
    } as WireEvent);
    await socket.until((sent) => socket.joined().includes(" resumed"));
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

  it("drops frames without crashing while the socket is reconnecting", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-sess-"));
    const agent = stubAgent(dir, 'printf "one\\n"; sleep 0.4; printf "two\\n"');
    const socket = new OfflineFirstSocket();
    const errors: string[] = [];
    const session = new AgentSession({
      agent: "claude",
      command: "bash",
      args: [agent],
      cwd: dir,
      socket: socket as never,
      sessionId: "sess_1",
      config: { safeCommands: [] },
      onError: (message) => errors.push(message),
    });
    session.start();
    await socket.until((s) => s.dropped.includes("TERMINAL_DATA"));
    socket.offline = false;
    await socket.until((s) => s.joined().includes("two"));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("TERMINAL_DATA");
    expect(errors.join("\n")).not.toContain("one\\n"); // no frame bodies in errors
    session.stop();
  });

  it("ignores RESOLVE_INTERCEPT when no intercept is pending", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-sess-"));
    const agent = stubAgent(dir, 'read -n 1; printf "APPROVED-MARKER"');
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
      event: "RESOLVE_INTERCEPT",
      meta: { session_id: "sess_1" },
      payload: { decision: "APPROVE", input_payload: null },
    } as WireEvent);
    await new Promise((r) => setTimeout(r, 300));
    const chunks = socket.sent
      .map((e) => (e.payload as { chunk: string }).chunk)
      .join("");
    expect(chunks).not.toContain("APPROVED-MARKER");
    session.stop();
  });
});
