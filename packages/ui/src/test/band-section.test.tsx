import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { BandSection } from "../components/band-section";
import type { FleetBand } from "../lib/fleet-bands";
import { project } from "./fixtures";

function band(over: Partial<FleetBand> & Pick<FleetBand, "band" | "label">): FleetBand {
  return { projects: [project({ id: "ONE" }), project({ id: "TWO" })], ...over };
}

describe("BandSection", () => {
  test("renders the band label and its project count", () => {
    render(
      <BandSection
        band={band({ band: "live", label: "Live" })}
        readyByKey={new Map()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("Live")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
  });

  test("a non-collapsible band shows its cards directly", () => {
    render(
      <BandSection
        band={band({ band: "live", label: "Live" })}
        readyByKey={new Map()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("ONE")).toBeDefined();
    expect(screen.getByText("TWO")).toBeDefined();
  });

  test("a collapsible band hides its cards behind an expandable count strip", async () => {
    render(
      <BandSection
        band={band({ band: "at_rest", label: "At rest" })}
        readyByKey={new Map()}
        onOpen={vi.fn()}
        collapsible
      />,
    );
    // collapsed: cards absent, strip present
    expect(screen.queryByText("ONE")).toBeNull();
    const strip = screen.getByRole("button", { name: /at rest/i });
    await userEvent.click(strip);
    // expanded: cards now visible
    expect(screen.getByText("ONE")).toBeDefined();
    expect(screen.getByText("TWO")).toBeDefined();
  });
});
