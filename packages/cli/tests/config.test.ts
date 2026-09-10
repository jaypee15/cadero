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
  it("returns empty safelist when .caderorc is absent", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-cfg-"));
    expect(await loadConfig(dir)).toEqual({ safeCommands: [] });
  });

  it("loads safeCommands from .caderorc", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-cfg-"));
    writeFileSync(
      join(dir, ".caderorc"),
      JSON.stringify({ safeCommands: ["npm test", "git status"] }),
    );
    expect(await loadConfig(dir)).toEqual({ safeCommands: ["npm test", "git status"] });
  });

  it("fails loudly on malformed .caderorc", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-cfg-"));
    writeFileSync(join(dir, ".caderorc"), "{ not json");
    await expect(loadConfig(dir)).rejects.toThrow(".caderorc is not valid");
  });

  it("fails loudly when safeCommands is not a string array", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadero-cfg-"));
    writeFileSync(join(dir, ".caderorc"), JSON.stringify({ safeCommands: "npm test" }));
    await expect(loadConfig(dir)).rejects.toThrow(".caderorc is not valid");
  });
});
