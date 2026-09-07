import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InterceptOverlay } from "../src/components/InterceptOverlay.js";
import { PromptInput } from "../src/components/PromptInput.js";
import { GapBanner } from "../src/components/GapBanner.js";

afterEach(cleanup);

describe("InterceptOverlay", () => {
  it("shows the command and disables buttons while busy", () => {
    const onDecision = vi.fn();
    render(
      <InterceptOverlay
        intercept={{ id: "i", agent: "claude", command: "rm -rf ./dist" }}
        busy
        onDecision={onDecision}
      />,
    );
    expect(screen.getByText("rm -rf ./dist")).toBeDefined();
    const approve = screen.getByRole("button", { name: /approve/i });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("emits APPROVE and DENY", () => {
    const onDecision = vi.fn();
    render(
      <InterceptOverlay
        intercept={{ id: "i", agent: "claude", command: "npm test" }}
        busy={false}
        onDecision={onDecision}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(onDecision).toHaveBeenNthCalledWith(1, "APPROVE");
    expect(onDecision).toHaveBeenNthCalledWith(2, "DENY");
  });
});

describe("PromptInput", () => {
  it("sends trimmed prompts and ignores empties", () => {
    const onSend = vi.fn();
    render(<PromptInput disabled={false} onSend={onSend} />);
    const input = screen.getByPlaceholderText(/prompt/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  list the src dir  " } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).toHaveBeenCalledWith("list the src dir");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("disables input while an intercept is pending", () => {
    render(<PromptInput disabled onSend={() => {}} />);
    expect((screen.getByPlaceholderText(/prompt/i) as HTMLInputElement).disabled).toBe(true);
  });
});

describe("GapBanner", () => {
  it("renders only when visible", () => {
    const { rerender } = render(<GapBanner visible={false} />);
    expect(screen.queryByText(/Connection lost/)).toBeNull();
    rerender(<GapBanner visible />);
    expect(screen.getByText(/Connection lost/)).toBeDefined();
  });
});
