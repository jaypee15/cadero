import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("loadConfig", () => {
  it("returns empty safelist when .cadencerc is absent", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-cfg-"));
    expect(await loadConfig(dir)).toEqual({ safeCommands: [] });
  });

  it("loads safeCommands from .cadencerc", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-cfg-"));
    writeFileSync(
      join(dir, ".cadencerc"),
      JSON.stringify({ safeCommands: ["npm test", "git status"] }),
    );
    expect(await loadConfig(dir)).toEqual({ safeCommands: ["npm test", "git status"] });
  });

  it("fails loudly on malformed .cadencerc", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-cfg-"));
    writeFileSync(join(dir, ".cadencerc"), "{ not json");
    await expect(loadConfig(dir)).rejects.toThrow(".cadencerc is not valid");
  });

  it("fails loudly when safeCommands is not a string array", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-cfg-"));
    writeFileSync(join(dir, ".cadencerc"), JSON.stringify({ safeCommands: "npm test" }));
    await expect(loadConfig(dir)).rejects.toThrow(".cadencerc is not valid");
  });
});
