// packages/mobile/tests/sessionTabs.test.tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WireEvent } from "@cadero/protocol";
import { CaderoApp } from "../src/app/CaderoApp.js";
import type { MobileSocketOptions } from "../src/realtime/socket.js";
import { createSessionStore, type SessionStore, type SocketLike } from "../src/state/sessionStore.js";

const writes: string[] = [];

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

vi.mock("@xterm/xterm", () => {
  class Terminal {
    constructor(_opts: unknown) {}
    write(chunk: string) {
      writes.push(chunk);
    }
    loadAddon() {}
    open() {}
    reset() {}
    dispose() {}
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

interface SentEvent {
  event: WireEvent;
}

interface FakeSession {
  opts: MobileSocketOptions;
  sent: SentEvent[];
  socket: SocketLike;
}

function makeHarness() {
  const sessions: FakeSession[] = [];
  const factory = (opts: MobileSocketOptions): SocketLike => {
    const fake: FakeSession = {
      opts,
      sent: [],
      socket: {
        connect: () => Promise.resolve(),
        send: (event: WireEvent) => {
          fake.sent.push({ event });
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      },
    };
    sessions.push(fake);
    return fake.socket;
  };
  const store: SessionStore = createSessionStore({ socketFactory: factory });
  return { store, sessions };
}

async function pairTwo(store: SessionStore, sessions: FakeSession[]) {
  await store.addSession({ relay: "http://r", room: "room_aaaas", key: "A".repeat(43) }, "tok");
  await store.addSession({ relay: "http://r", room: "room_bbbbs", key: "A".repeat(43) }, "tok");
  // Background session B receives output while A is active.
  sessions[0].opts.onEvent({
    event: "TERMINAL_DATA",
    meta: { session_id: "s" },
    payload: { chunk: "room A content" },
  });
  sessions[1].opts.onEvent({
    event: "TERMINAL_DATA",
    meta: { session_id: "s" },
    payload: { chunk: "room B content" },
  });
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  writes.length = 0;
});

describe("session tabs", () => {
  it("renders one tab per paired session, with the pending-approval badge on the right tab", async () => {
    const { store, sessions } = makeHarness();
    await pairTwo(store, sessions);
    sessions[1].opts.onEvent({
      event: "INTERCEPT_REQUIRED",
      meta: { session_id: "sess_1", timestamp: 42 },
      payload: { agent: "opencode", reason: "EXECUTE_COMMAND", command: "rm -rf /tmp/x" },
    });

    render(<CaderoApp store={store} />);
    const tabs = await vi.waitFor(() => screen.getAllByRole("tab"));
    expect(tabs).toHaveLength(2);
    const tabA = screen.getByTestId("tab-room_aaaas");
    const tabB = screen.getByTestId("tab-room_bbbbs");
    expect(tabA.querySelector('[data-pending="true"]')).toBeNull();
    expect(tabB.querySelector('[data-pending="true"]')).not.toBeNull();
  });

  it("switching tabs activates that session and shows its intercept overlay", async () => {
    const { store, sessions } = makeHarness();
    await pairTwo(store, sessions);
    sessions[1].opts.onEvent({
      event: "INTERCEPT_REQUIRED",
      meta: { session_id: "sess_1", timestamp: 42 },
      payload: { agent: "opencode", reason: "EXECUTE_COMMAND", command: "rm -rf /tmp/x" },
    });

    render(<CaderoApp store={store} />);
    expect(store.getSnapshot().activeId).toBe("room_bbbbs"); // latest pair wins
    store.setActive("room_aaaas"); // move active to A: B's overlay must not show yet
    await vi.waitFor(() => expect(screen.queryByText(/action required/i)).toBeNull());

    fireEvent.click(screen.getByTestId("tab-room_bbbbs"));
    expect(store.getSnapshot().activeId).toBe("room_bbbbs");
    expect(await vi.waitFor(() => screen.getByText(/action required/i))).toBeDefined();
  });

  it("refills the terminal from the newly active room's buffer on switch", async () => {
    const { store, sessions } = makeHarness();
    await pairTwo(store, sessions);
    store.setActive("room_aaaas"); // initial active: A

    render(<CaderoApp store={store} />);
    await vi.waitFor(() => {
      expect(writes.some((w) => w.includes("room A content"))).toBe(true);
    });

    fireEvent.click(screen.getByTestId("tab-room_bbbbs"));
    await vi.waitFor(() => {
      expect(writes.some((w) => w.includes("room B content"))).toBe(true);
    });
  });

  it("opens the pairing screen from the live screen via + Pair", async () => {
    const { store, sessions } = makeHarness();
    await pairTwo(store, sessions);

    render(<CaderoApp store={store} />);
    fireEvent.click(screen.getByRole("button", { name: /pair/i }));
    expect(await vi.waitFor(() => screen.getByText(/pair with your desktop/i))).toBeDefined();
  });

  it("routes the Send prompt to the active session's socket", async () => {
    const { store, sessions } = makeHarness();
    await pairTwo(store, sessions);

    render(<CaderoApp store={store} />);
    fireEvent.click(screen.getByTestId("tab-room_bbbbs"));
    const input = screen.getByPlaceholderText(/prompt/i);
    fireEvent.change(input, { target: { value: "list the src dir" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await vi.waitFor(() => {
      expect(sessions[1].sent.some((s) => s.event.event === "EXECUTE_AGENT_PROMPT")).toBe(true);
    });
    const prompt = sessions[1].sent.find((s) => s.event.event === "EXECUTE_AGENT_PROMPT")!;
    expect((prompt.event.payload as { prompt: string }).prompt).toBe("list the src dir");
    // The background session must NOT have been prompted.
    expect(sessions[0].sent).toHaveLength(0);
  });
});
