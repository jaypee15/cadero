// packages/mobile/tests/appFlow.test.tsx
import { describe, expect, it } from "vitest";
import { readOAuthTokenFromHash } from "../src/app/oauth.js";

describe("readOAuthTokenFromHash", () => {
  it("extracts and strips the token hash", () => {
    window.location.hash = "#token=cadence_abc";
    expect(readOAuthTokenFromHash()).toBe("cadence_abc");
    expect(window.location.hash).toBe("");
    expect(readOAuthTokenFromHash()).toBeNull();
  });
});
