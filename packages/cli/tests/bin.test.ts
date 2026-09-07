import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const distMain = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "main.js",
);

describe("bin entrypoint (symlink invocation)", () => {
  it("prints usage when invoked through a symlink", () => {
    expect(existsSync(distMain)).toBe(true); // `npm run build` must run first
    const dir = mkdtempSync(join(tmpdir(), "cadence-bin-"));
    const link = join(dir, "cadence-cli");
    symlinkSync(distMain, link);
    try {
      const stdout = execFileSync(process.execPath, [link, "--help"], {
        encoding: "utf8",
        timeout: 15000,
      });
      expect(stdout).toContain("cadence-cli");
      expect(stdout).toContain("Usage:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
