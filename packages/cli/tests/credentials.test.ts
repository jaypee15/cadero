import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCredentials, saveCredentials } from "../src/credentials.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("credentials", () => {
  it("saves and loads credentials with 0600 permissions", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-creds-"));
    await saveCredentials(dir, { githubToken: "tok123" });
    expect(await loadCredentials(dir)).toEqual({ githubToken: "tok123" });
    const stat = (await import("node:fs")).statSync(join(dir, "credentials.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("returns null when no credentials exist", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-creds-"));
    expect(await loadCredentials(dir)).toBeNull();
  });
});
