import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { ProjectSettingsButton } from "../components/project-settings-button";
import type { WireNode } from "../api/types";

const { apiSend } = vi.hoisted(() => ({ apiSend: vi.fn() }));
vi.mock("../api/client", () => ({ apiSend }));
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn() } }));
vi.mock("sonner", () => ({ toast }));

afterEach(() => {
  vi.clearAllMocks();
});

function wrap(ui: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

const baseProject: WireNode = {
  id: "MMR",
  type: "project",
  title: "My Project",
  status: "in_progress",
  parent: null,
  description: "A handy description",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

describe("ProjectSettingsButton", () => {
  test("renders a settings button", () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    expect(screen.getByRole("button", { name: /project settings/i })).toBeInTheDocument();
  });

  test("is disabled when offline", () => {
    wrap(<ProjectSettingsButton project={baseProject} offline />);
    expect(screen.getByRole("button", { name: /project settings/i })).toBeDisabled();
  });

  test("clicking opens the sheet with name and description fields prefilled", () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    fireEvent.click(screen.getByRole("button", { name: /project settings/i }));
    expect(screen.getByLabelText(/name/i)).toHaveValue("My Project");
    expect(screen.getByLabelText(/description/i)).toHaveValue("A handy description");
  });

  test("description field is empty when project has no description", () => {
    const project = { ...baseProject, description: null };
    wrap(<ProjectSettingsButton project={project} />);
    fireEvent.click(screen.getByRole("button", { name: /project settings/i }));
    expect(screen.getByLabelText(/description/i)).toHaveValue("");
  });

  test("Save button disabled when name is cleared", () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    fireEvent.click(screen.getByRole("button", { name: /project settings/i }));
    const nameInput = screen.getByLabelText(/name/i);
    fireEvent.change(nameInput, { target: { value: "" } });
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  test("submitting calls PATCH /api/projects/:key with title and description", async () => {
    apiSend.mockResolvedValue({ id: "MMR", title: "Renamed", description: "New desc" });
    wrap(<ProjectSettingsButton project={baseProject} />);
    fireEvent.click(screen.getByRole("button", { name: /project settings/i }));

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Renamed" } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: "New desc" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await vi.waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith("PATCH", "/api/projects/MMR", {
        title: "Renamed",
        description: "New desc",
      });
    });
  });
});

describe("FleetCard description display", () => {
  test("project description appears on the fleet card when present", async () => {
    // Import FleetCard here to keep the test co-located with the feature
    const { FleetCard } = await import("../components/fleet-card");
    render(<FleetCard project={baseProject} onOpen={() => {}} />);
    expect(screen.getByText("A handy description")).toBeInTheDocument();
  });

  test("no description slot rendered when description is null", async () => {
    const { FleetCard } = await import("../components/fleet-card");
    const project = { ...baseProject, description: null };
    render(<FleetCard project={project} onOpen={() => {}} />);
    expect(screen.queryByText(/description/i)).toBeNull();
  });
});
