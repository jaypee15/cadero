import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Home from "../src/app/page";

describe("mobile scaffold", () => {
  it("renders the hydratable loading shell before CaderoApp mounts", () => {
    render(<Home />);
    expect(screen.getByText("Loading…")).toBeDefined();
  });
});
