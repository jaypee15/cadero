import { describe, expect, it } from "vitest";
import { redactForLog } from "../src/logging.js";

describe("redactForLog", () => {
  it("keeps the room id but strips body fields", () => {
    const line = redactForLog({
      room_id: "room_abc",
      iv: "aXZ2",
      ciphertext: "c2VjcmV0",
      chunk: "rm -rf /",
    });
    expect(line).toContain("room_abc");
    expect(line).not.toContain("c2VjcmV0");
    expect(line).not.toContain("rm -rf /");
  });
});
