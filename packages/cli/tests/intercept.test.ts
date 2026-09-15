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

  it("catches claude's workspace trust dialog with arrow-down + Enter approval", () => {
    const chunk =
      "Accessing workspace:\n /Users/x/cadence\n\n Quick safety check: Is this a project you created or one you trust?";
    const hit = detectIntercept("claude", chunk);
    expect(hit).not.toBeNull();
    expect(hit!.approveInput).toBe("\u001b[B|\r");
    expect(hit!.prompt).toContain("trust");
  });

  it("catches the trust dialog even when claude litters it with cursor moves", () => {
    // Real claude output positions every word: "Quick\x1b[8Gsafety\x1b[15Gcheck:…"
    const chunk =
      "\u001b[2GQuick\u001b[8Gsafety\u001b[15Gcheck:\u001b[22GIs\u001b[25Gthis\u001b[30Ga\u001b[32Gproject\u001b[40Gyou\u001b[44Gcreated\u001b[52Gor\u001b[55Gone\u001b[59Gyou\u001b[63Gtrust?\u001b[70G(Like\u001b[76Gyour";
    const hit = detectIntercept("claude", chunk);
    expect(hit).not.toBeNull();
    expect(hit!.approveInput).toBe("\u001b[B|\r");
    expect(hit!.prompt).toContain("trust");
  });
});

describe("isSafeCommand", () => {
  it("matches after whitespace collapsing", () => {
    expect(isSafeCommand("npm  test", ["npm test"])).toBe(true);
    expect(isSafeCommand("npm run build", ["npm test"])).toBe(false);
  });
});
