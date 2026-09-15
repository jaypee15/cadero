// packages/mobile/tests/appFlow.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { readOAuthTokenFromHash } from "../src/app/oauth.js";
import { CaderoApp } from "../src/app/CaderoApp.js";

describe("readOAuthTokenFromHash", () => {
  it("extracts and strips the token hash", () => {
    window.location.hash = "#token=cadero_abc";
    expect(readOAuthTokenFromHash()).toBe("cadero_abc");
    expect(window.location.hash).toBe("");
    expect(readOAuthTokenFromHash()).toBeNull();
  });
});

describe("pairing screen", () => {
  it("offers GitHub sign-in via the same-origin oauth portal", () => {
    render(<CaderoApp />);
    const link = screen.getByRole("link", { name: /sign in with github/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("/v1/oauth/login");
  });
});
