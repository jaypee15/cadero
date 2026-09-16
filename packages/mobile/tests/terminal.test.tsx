import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { TerminalView } from "../src/components/TerminalView.js";

const write = vi.fn();
const fit = vi.fn();
const dispose = vi.fn();

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

afterEach(() => {
  // The stub must not leak into other test files' jsdom environments.
  vi.unstubAllGlobals();
});

vi.mock("@xterm/xterm", () => {
  class Terminal {
    onLoad = undefined as unknown as () => void;
    constructor(_opts: unknown) {}
    write(chunk: string) {
      write(chunk);
    }
    loadAddon() {}
    open() {}
  }
  return { Terminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {
      fit();
    }
    dispose() {
      dispose();
    }
  },
}));

describe("TerminalView", () => {
  it("hands the parent a write/fit/dispose api once mounted", async () => {
    let api: { write(chunk: string): void } | undefined;
    render(<TerminalView onReady={(a) => (api = a)} />);
    // useEffect runs synchronously in jsdom with React 19 + testing-library act
    await vi.waitFor(() => expect(api).toBeDefined());
    api!.write("hello");
    expect(write).toHaveBeenCalledWith("hello");
  });
});
