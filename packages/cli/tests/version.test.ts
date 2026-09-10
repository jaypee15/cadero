import { describe, expect, it } from "vitest";
import { CADERO_VERSION } from "../src/version.js";

describe("version", () => {
  it("matches the package version", () => {
    expect(CADERO_VERSION).toBe("0.1.0");
  });
});
