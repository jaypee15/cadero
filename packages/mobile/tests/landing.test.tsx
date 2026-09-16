// packages/mobile/tests/landing.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import Home from "../src/app/page.js";
import { shouldForwardToApp } from "../src/app/HashForward.js";
import AppPage from "../src/app/app/page.js";

// jsdom cannot run real xterm; the /app test waits for its async import.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    write() {}
    loadAddon() {}
    open() {}
    reset() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    dispose() {}
  },
}));

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("landing page (/)", () => {
  it("presents the product with a CTA into the app", () => {
    render(<Home />);
    expect(screen.getByText(/in your pocket/i)).toBeDefined();
    expect(screen.getByText(/zero-knowledge/i) ?? screen.getAllByText(/zero-knowledge/i)[0]).toBeDefined();
    const cta = screen.getAllByRole("link", { name: /get started/i })[0] as HTMLAnchorElement;
    expect(cta.getAttribute("href")).toBe("/app");
  });

  it("renders the how-it-works steps", () => {
    render(<Home />);
    expect(screen.getByText(/Start a session/i)).toBeDefined();
    expect(screen.getByText(/Scan from the phone/i)).toBeDefined();
    expect(screen.getByText(/Stay in control/i)).toBeDefined();
  });
});

describe("HashForward", () => {
  it("forwards oauth tokens and deep links to the app", () => {
    expect(shouldForwardToApp("#token=cadero_abc", false)).toBe(true);
    expect(shouldForwardToApp("#pair=cadero%3A%2F%2Fp", false)).toBe(true);
    expect(shouldForwardToApp("", true)).toBe(true);
    expect(shouldForwardToApp("", false)).toBe(false);
    expect(shouldForwardToApp("#something-else", false)).toBe(false);
  });
});

describe("app route (/app)", () => {
  it("renders the app through its dynamic loading shell", async () => {
    render(<AppPage />);
    await vi.waitFor(() => expect(screen.getByText("Loading…")).toBeDefined());
    // The dynamic import resolves to the full pairing screen.
    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: /scan qr code/i })).toBeDefined();
    });
  });
});
