import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { FleetCard } from "../components/fleet-card";
import { project } from "./fixtures";

describe("FleetCard going-cold marker", () => {
  test("a stale project shows a going-cold marker", () => {
    render(
      <FleetCard
        project={project({
          id: "COLD",
          attention: { band: "live", last_activity: "2026-01-01T00:00:00.000Z", stale: true },
        })}
        ready={1}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText(/going cold/i)).toBeDefined();
  });

  test("a fresh project shows no going-cold marker", () => {
    render(
      <FleetCard
        project={project({
          id: "WARM",
          attention: { band: "live", last_activity: "2026-06-20T00:00:00.000Z", stale: false },
        })}
        ready={1}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.queryByText(/going cold/i)).toBeNull();
  });
});
