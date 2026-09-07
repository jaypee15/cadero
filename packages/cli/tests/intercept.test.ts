import { describe, expect, it } from "vitest";
import { detectIntercept, isSafeCommand } from "../src/intercept.js";

describe("detectIntercept", () => {
  it("catches claude tool-confirmation prompts and extracts the command", () => {
    const chunk =
      "\u001b[36mClaude wants to run:\u001b[0m\nnpm run build\nDo you want to proceed? [y/N]";
    const hit = detectIntercept("claude", chunk);
    expect(hit).not.toBeNull();
    expect(hit!.prompt).toContain("Do you want to proceed? [y/N]");
    expect(hit!.command).toBe("npm run build");
  });

  it("falls back to the prompt text when no command line precedes it", () => {
    const chunk = "Press Enter to continue";
    const hit = detectIntercept("claude", chunk);
    expect(hit).not.toBeNull();
    expect(hit!.command).toBe("Press Enter to continue");
  });

  it("catches opencode waiting-for-input markers", () => {
    const chunk = "…waiting for your input ›";
    expect(detectIntercept("opencode", chunk)).not.toBeNull();
  });

  it("passes ordinary output through", () => {
    expect(detectIntercept("claude", "I scanned the directory and found 3 files.")).toBeNull();
  });
});

describe("isSafeCommand", () => {
  it("matches after whitespace collapsing", () => {
    expect(isSafeCommand("npm  test", ["npm test"])).toBe(true);
    expect(isSafeCommand("npm run build", ["npm test"])).toBe(false);
  });
});
