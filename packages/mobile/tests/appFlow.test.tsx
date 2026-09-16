// packages/mobile/tests/appFlow.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readOAuthTokenFromHash } from "../src/app/oauth.js";
import { CaderoApp } from "../src/app/CaderoApp.js";
import { createSessionStore } from "../src/state/sessionStore.js";

// jsdom cannot run real xterm (no canvas/matchMedia); the deep-link tests
// wait long enough for the async import to resolve, so stub the module.
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

describe("deep-link pairing", () => {
  afterEach(() => {
    sessionStorage.clear();
    window.location.hash = "";
  });

  const KEY_43 = "B".repeat(43);
  const PAYLOAD = `cadero://p?r=https%3A%2F%2Fcadero.dev&m=room_deep1234abcd&k=${KEY_43}`;

  function fakeStore() {
    const created: { roomId: string }[] = [];
    const store = createSessionStore({
      socketFactory: () => ({
        connect: () => {
          created.push({ roomId: "" });
          return Promise.resolve();
        },
        send: () => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
    });
    return { store, created };
  }

  it("auto-imports a #pair= deep link once signed in", async () => {
    sessionStorage.setItem("cadero_oauth_token", "cadero_abc");
    const { store, created } = fakeStore();
    window.location.hash = `#pair=${encodeURIComponent(PAYLOAD)}`;
    render(<CaderoApp store={store} />);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(store.getSnapshot().activeId).toBe("room_deep1234abcd");
    // The hash and the stash are consumed.
    expect(window.location.hash).toBe("");
    expect(sessionStorage.getItem("cadero_pairing_stash")).toBeNull();
  });

  it("stashes the #pair= payload when not yet signed in, then auto-imports after the oauth return", async () => {
    const { store, created } = fakeStore();
    window.location.hash = `#pair=${encodeURIComponent(PAYLOAD)}`;
    render(<CaderoApp store={store} />);
    // No token yet: the pairing screen shows, the payload waits in the stash.
    await vi.waitFor(() => {
      expect(sessionStorage.getItem("cadero_pairing_stash")).toBe(PAYLOAD);
    });
    expect(created).toHaveLength(0);

    // The OAuth callback returns with the token: remount simulates the
    // redirect landing.
    cleanup();
    window.location.hash = "#token=cadero_abc";
    render(<CaderoApp store={store} />);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(sessionStorage.getItem("cadero_pairing_stash")).toBeNull();
  });

  it("stays on the pairing screen for an invalid #pair= payload", () => {
    sessionStorage.setItem("cadero_oauth_token", "cadero_abc");
    window.location.hash = `#pair=${encodeURIComponent("not-a-payload")}`;
    render(<CaderoApp />);
    expect(screen.getByRole("button", { name: /scan qr code/i })).toBeDefined();
    // The invalid stash is dropped so a later sign-in cannot trip on it.
    expect(sessionStorage.getItem("cadero_pairing_stash")).toBeNull();
  });
});
