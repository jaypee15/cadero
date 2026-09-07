import { describe, expect, it } from "vitest";
import { CADENCE_VERSION } from "../src/version.js";

describe("version", () => {
  it("matches the package version", () => {
    expect(CADENCE_VERSION).toBe("0.1.0");
  });
});
