import { describe, expect, it } from "vitest";
import { createPtySession } from "../src/pty.js";

function untilContains(
  session: { onData(cb: (chunk: string) => void): void; kill(): void },
  needle: string,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      session.kill();
      reject(new Error(`timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(buffer)}`));
    }, timeoutMs);
    session.onData((chunk) => {
      buffer += chunk;
      if (buffer.includes(needle)) {
        clearTimeout(timer);
        resolve(buffer);
      }
    });
  });
}

describe("createPtySession", () => {
  it("streams output from a real process", async () => {
    const session = createPtySession({
      command: "bash",
      args: ["-c", "printf hello-pty; exit 0"],
      cwd: process.cwd(),
    });
    const buffer = await untilContains(session, "hello-pty");
    expect(buffer).toContain("hello-pty");
    session.kill();
  });

  it("writes input into the running process", async () => {
    const session = createPtySession({
      command: "bash",
      args: ["-c", 'read line; printf "got:%s" "$line"'],
      cwd: process.cwd(),
    });
    await new Promise((r) => setTimeout(r, 300));
    session.write("from-cadence\r");
    const buffer = await untilContains(session, "got:from-cadence");
    expect(buffer).toContain("got:from-cadence");
    session.kill();
  });

  it("throws a clear error for a missing binary", () => {
    expect(() =>
      createPtySession({ command: "definitely-not-a-real-agent-xyz", cwd: process.cwd() }),
    ).toThrow(/failed to start/);
  });
});
