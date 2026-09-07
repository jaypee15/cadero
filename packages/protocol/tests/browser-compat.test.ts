import { describe, expect, it } from "vitest";
import {
  decryptEnvelope,
  encryptEnvelope,
  exportSessionKey,
  generateSessionKey,
  importSessionKey,
} from "../src/index.js";

describe("protocol is browser-compatible (no Buffer)", () => {
  it("round-trips using only btoa/atob-backed helpers", async () => {
    const key = await generateSessionKey();
    const raw = await exportSessionKey(key);
    const imported = await importSessionKey(raw);
    const event = {
      event: "TERMINAL_DATA",
      meta: { session_id: "sess_1" },
      payload: { chunk: "unicode ✓ ✓" },
    } as const;
    const env = await encryptEnvelope("room_1", imported, event);
    expect(await decryptEnvelope(imported, env)).toEqual(event);
  });

  it("does not reference Buffer in bundle sources", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const srcDir = join(import.meta.dirname, "..", "src");
    const files = ["envelope.ts", "keys.ts", "pairing.ts"];
    for (const file of files) {
      expect(readFileSync(join(srcDir, file), "utf8")).not.toMatch(/\bBuffer\b/);
    }
  });
});
