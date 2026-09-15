import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WireEvent } from "@cadero/protocol";
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
  closeArgs: Array<{ code?: number; reason?: string }> = [];
  async close(code?: number, reason?: string): Promise<void> {
    this.closeArgs.push({ code, reason });
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
    dir = mkdtempSync(join(tmpdir(), "cadero-sess-"));
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
    dir = mkdtempSync(join(tmpdir(), "cadero-sess-"));
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
    // The intercept hit was safe-listed: no INTERCEPT_REQUIRED went out,
    // the approval keystroke was written straight into the PTY, and the
    // post-approval output arrives.
    expect(socket.sent.some((e) => e.event === "INTERCEPT_REQUIRED")).toBe(false);
    const chunks = socket.joined();
    expect(chunks).toContain(" done");
    session.stop();
  });

  it("raises INTERCEPT_REQUIRED for unsafe commands and resumes on APPROVE", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-sess-"));
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
    dir = mkdtempSync(join(tmpdir(), "cadero-sess-"));
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
    dir = mkdtempSync(join(tmpdir(), "cadero-sess-"));
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
    dir = mkdtempSync(join(tmpdir(), "cadero-sess-"));
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
    dir = mkdtempSync(join(tmpdir(), "cadero-sess-"));
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

  it("denies and tears down when the intercept times out", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-sess-"));
    const agent = stubAgent(
      dir,
      'printf "rm -rf ./dist\\nDo you want to proceed? [y/N]"; sleep 5; printf " never"',
    );
    const socket = new FakeSocket();
    (socket as { close?: () => void }).close = vi.fn();
    const session = new AgentSession({
      agent: "claude",
      command: "bash",
      args: [agent],
      cwd: dir,
      socket: socket as never,
      sessionId: "sess_1",
      config: { safeCommands: [] },
      interceptTimeoutMs: 150,
    });
    session.start();
    await socket.all(1); // INTERCEPT_REQUIRED emitted
    const intercept = socket.sent.find((e) => e.event === "INTERCEPT_REQUIRED");
    expect(intercept).toBeDefined();
    // within 2s the timeout fires: notice frame, escape written, socket closed
    await socket.until((sent) =>
      sent.some((e) => (e.payload as { chunk?: string }).chunk?.includes("timed out")),
    );
    const notice = socket.sent.find(
      (e) =>
        e.event === "TERMINAL_DATA" &&
        (e.payload as { chunk?: string }).chunk?.includes("timed out"),
    );
    expect(notice).toBeDefined();
    expect(notice!.event).toBe("TERMINAL_DATA");
    expect((notice!.payload as { chunk: string }).chunk).toContain("intercept timed out");
    expect((socket as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalled();
    session.stop();
  }, 10000);

  it("does not time out an intercept that is resolved in time", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-sess-"));
    const agent = stubAgent(
      dir,
      'printf "rm -rf ./dist\\nDo you want to proceed? [y/N]"; read -n 1; printf " continued"',
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
      interceptTimeoutMs: 5000,
    });
    session.start();
    await socket.all(1);
    socket.handler!({
      event: "RESOLVE_INTERCEPT",
      meta: { session_id: "sess_1" },
      payload: { decision: "APPROVE", input_payload: null },
    } as WireEvent);
    await socket.all(3);
    expect(socket.sent.some((e) => (e.payload as { chunk?: string }).chunk?.includes("timed out"))).toBe(false);
    session.stop();
  }, 10000);

  it("mirrors agent output to the local operator", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-sess-"));
    const agent = stubAgent(dir, 'printf "operator-marker"');
    const socket = new FakeSocket();
    const local: string[] = [];
    const session = new AgentSession({
      agent: "claude",
      command: "bash",
      args: [agent],
      cwd: dir,
      socket: socket as never,
      sessionId: "sess_1",
      config: { safeCommands: [] },
      onLocalOutput: (chunk) => local.push(chunk),
    });
    session.start();
    await socket.until((events) => events.some((e) => (e.payload as { chunk?: string }).chunk?.includes("operator-marker")));
    expect(local.join("")).toContain("operator-marker");
    session.stop();
  }, 10000);

  it("closes the session and notifies onEnd when the agent exits", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-sess-"));
    const agent = stubAgent(dir, 'printf "bye"; exit 7');
    const socket = new FakeSocket();
    const ended: number[] = [];
    const session = new AgentSession({
      agent: "claude",
      command: "bash",
      args: [agent],
      cwd: dir,
      socket: socket as never,
      sessionId: "sess_1",
      config: { safeCommands: [] },
      onEnd: (code) => ended.push(code),
    });
    session.start();
    await socket.until((events) => events.some((e) => e.event === "SESSION_ENDED"));
    const endedEvent = socket.sent.find((e) => e.event === "SESSION_ENDED");
    expect((endedEvent!.payload as { code: number }).code).toBe(7);
    expect(ended).toEqual([7]);
    expect(socket.closeArgs.length).toBe(1);
    session.stop();
  }, 10000);

  it("resizes the pty to the dimensions the phone sends", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-sess-"));
    const agent = stubAgent(dir, "sleep 0.8; stty size; sleep 2");
    const socket = new FakeSocket();
    const session = new AgentSession({
      agent: "claude",
      command: "bash",
      args: [agent],
      cwd: dir,
      socket: socket as never,
      sessionId: "sess_1",
      config: { safeCommands: [] },
      interceptReEmitMs: 50,
    });
    session.start();
    socket.handler!({
      event: "TERMINAL_RESIZE",
      meta: { session_id: "sess_1" },
      payload: { cols: 50, rows: 24 },
    } as WireEvent);
    // stty prints "rows cols"
    await socket.until((sent) => socket.joined().includes("24 50"));
    session.stop();
  }, 10000);

  it("sends the trust dialog to the phone and writes Enter on approve", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-sess-"));
    const agent = stubAgent(
      dir,
      'printf "Quick safety check: Is this a project you created or one you trust?"; read -r -n 3 k; printf "key<%s>" "$k"; printf " trusted"',
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
    await socket.until((sent) => sent.some((e) => e.event === "INTERCEPT_REQUIRED"));
    const intercept = socket.sent.find((e) => e.event === "INTERCEPT_REQUIRED");
    // Fixture has no preceding workspace line, so the command falls back to
    // the matched dialog text itself.
    expect((intercept!.payload as { command: string }).command).toContain("trust");
    socket.handler!({
      event: "RESOLVE_INTERCEPT",
      meta: { session_id: "sess_1" },
      payload: { decision: "APPROVE", input_payload: null },
    } as WireEvent);
    await socket.until((sent) => socket.joined().includes(" trusted"));
    // The trust dialog is a selection list: approval is the arrow-down
    // sequence (ESC [ B) that selects "Yes, I trust this folder" — never the
    // "y" keystroke used for text prompts.
    expect(socket.joined()).toContain("key<\u001b[B>");
    expect(socket.joined()).not.toContain("key<y>");
    session.stop();
  }, 10000);

  it("re-emits INTERCEPT_REQUIRED while pending so a late-joining phone sees it", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-sess-"));
    const agent = stubAgent(
      dir,
      'printf "rm -rf ./dist\\nDo you want to proceed? [y/N]"; sleep 5; printf " never"',
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
      interceptTimeoutMs: 10000,
      interceptReEmitMs: 50,
    });
    session.start();
    await socket.until(
      (sent) => sent.filter((e) => e.event === "INTERCEPT_REQUIRED").length >= 2,
      3000,
    );
    session.stop();
  }, 10000);

  it("stops re-emitting once the intercept is resolved", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-sess-"));
    const agent = stubAgent(
      dir,
      'printf "rm -rf ./dist\\nDo you want to proceed? [y/N]"; read -r -n 1 k; printf " resolved"',
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
      interceptReEmitMs: 50,
    });
    session.start();
    await socket.until((sent) => sent.some((e) => e.event === "INTERCEPT_REQUIRED"));
    socket.handler!({
      event: "RESOLVE_INTERCEPT",
      meta: { session_id: "sess_1" },
      payload: { decision: "APPROVE", input_payload: null },
    } as WireEvent);
    await socket.until((sent) => socket.joined().includes(" resolved"));
    const count = socket.sent.filter((e) => e.event === "INTERCEPT_REQUIRED").length;
    await new Promise((r) => setTimeout(r, 300));
    expect(socket.sent.filter((e) => e.event === "INTERCEPT_REQUIRED").length).toBe(count);
    session.stop();
  }, 10000);
});
