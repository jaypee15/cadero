import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "../src/app/page.js";

describe("mobile scaffold", () => {
  it("renders the placeholder shell", () => {
    render(<Home />);
    expect(screen.getByText(/Cadence mobile/)).toBeDefined();
  });
});
