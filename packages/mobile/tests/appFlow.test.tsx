// packages/mobile/tests/appFlow.test.tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readOAuthTokenFromHash } from "../src/app/oauth.js";
import { CaderoApp } from "../src/app/CaderoApp.js";

afterEach(cleanup);

describe("readOAuthTokenFromHash", () => {
  it("extracts and strips the token hash", () => {
    window.location.hash = "#token=cadero_abc";
    expect(readOAuthTokenFromHash()).toBe("cadero_abc");
    expect(window.location.hash).toBe("");
    expect(readOAuthTokenFromHash()).toBeNull();
  });
});

describe("pairing screen", () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it("offers GitHub sign-in via the same-origin oauth portal", () => {
    render(<CaderoApp />);
    const link = screen.getByRole("link", { name: /sign in with github/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("/v1/oauth/login");
  });

  it("shows a signed-in state when the oauth callback returned a token", () => {
    window.location.hash = "#token=cadero_abc";
    render(<CaderoApp />);
    expect(screen.getByText(/signed in/i)).toBeDefined();
    expect(screen.queryByRole("link", { name: /sign in with github/i })).toBeNull();
  });

  it("restores the signed-in state from sessionStorage across reloads", () => {
    sessionStorage.setItem("cadero_oauth_token", "cadero_abc");
    render(<CaderoApp />);
    expect(screen.getByText(/signed in/i)).toBeDefined();
    expect(screen.queryByRole("link", { name: /sign in with github/i })).toBeNull();
  });
});
