import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { NodeDrawer } from "../components/node-drawer";
import { task } from "./fixtures";

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock("../api/client", () => ({ apiGet, apiSend }));

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("NodeDrawer", () => {
  test("renders the full record with annotations and artifact titles", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === "/api/nodes/MMR-16") {
        return Promise.resolve(
          task({
            id: "MMR-16",
            status: "in_progress",
            title: "Web UI chunk 1",
            priority: "p1",
            size: "large",
            tags: [{ tag: "release:v0.5", note: null, created_at: "2026-06-10T00:00:00.000Z" }],
            deps: {
              depends_on: [{ id: "MMR-15", status: "done" }],
              blocking: [{ id: "MMR-51", status: "awaiting" }],
            },
            artifacts: [
              {
                id: "MMR-a3",
                title: "console design notes",
                tags: [],
                created_at: "2026-06-10T00:00:00.000Z",
              },
            ],
          }),
        );
      }
      if (path === "/api/nodes/MMR-16/annotations") {
        return Promise.resolve({
          total: 1,
          items: [
            {
              content: "Groomed: read-only console first.",
              created_at: "2026-06-10T01:00:00.000Z",
            },
          ],
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });

    render(<NodeDrawer nodeId="MMR-16" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });

    expect(await screen.findByText("Web UI chunk 1")).toBeDefined();
    expect(await screen.findByText("Groomed: read-only console first.")).toBeDefined();
    expect(await screen.findByText("console design notes")).toBeDefined();
    expect(screen.getByText("MMR-15")).toBeDefined();
    expect(screen.getByText("MMR-51")).toBeDefined();
    expect(screen.getByText("release:v0.5")).toBeDefined();
    expect(screen.getByText("p1")).toBeDefined();
    expect(screen.getByText("In progress")).toBeDefined();
  });

  test("closed drawer renders nothing", () => {
    render(<NodeDrawer nodeId={undefined} onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });
    expect(screen.queryByTestId("drawer-body")).toBeNull();
  });

  test("shows the transition kebab for a live node", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === "/api/nodes/MMR-51") {
        return Promise.resolve(task({ id: "MMR-51", status: "ready", title: "Chunk 2" }));
      }
      if (path === "/api/nodes/MMR-51/annotations") {
        return Promise.resolve({ total: 0, items: [] });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(<NodeDrawer nodeId="MMR-51" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });
    expect(await screen.findByLabelText("Actions")).toBeDefined();
  });

  test("offline disables the drawer's transition kebab", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === "/api/nodes/MMR-51") {
        return Promise.resolve(task({ id: "MMR-51", status: "ready", title: "Chunk 2" }));
      }
      if (path === "/api/nodes/MMR-51/annotations") {
        return Promise.resolve({ total: 0, items: [] });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(<NodeDrawer nodeId="MMR-51" offline onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });
    expect(await screen.findByLabelText("Actions")).toHaveProperty("disabled", true);
  });

  test("edit button toggles the drawer into the task form, prefilled with node values", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === "/api/nodes/MMR-51") {
        return Promise.resolve(task({ id: "MMR-51", status: "ready", title: "Chunk 2 edit test" }));
      }
      if (path === "/api/nodes/MMR-51/annotations") {
        return Promise.resolve({ total: 0, items: [] });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(<NodeDrawer nodeId="MMR-51" offline={false} onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });
    // Wait for data to load
    await screen.findByText("Chunk 2 edit test");
    // Click the Edit button
    await userEvent.click(screen.getByRole("button", { name: /edit/i }));
    // Task form should be visible with the title prefilled
    const titleInput = screen.getByLabelText(/title/i);
    expect(titleInput).toBeDefined();
    expect((titleInput as HTMLInputElement).value).toBe("Chunk 2 edit test");
    // Save button should be present
    expect(screen.getByRole("button", { name: /save/i })).toBeDefined();
  });

  test("edit PATCH omits empty optional fields (no null values sent to server)", async () => {
    // Fixture: task with null description and external_ref (the default fixture state)
    apiGet.mockImplementation((path: string) => {
      if (path === "/api/nodes/MMR-65") {
        return Promise.resolve(
          task({
            id: "MMR-65",
            status: "ready",
            title: "Regression task",
            description: null,
            external_ref: null,
          }),
        );
      }
      if (path === "/api/nodes/MMR-65/annotations") {
        return Promise.resolve({ total: 0, items: [] });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    // apiSend must resolve so the mutate call succeeds
    apiSend.mockResolvedValue({ id: "MMR-65" });

    render(<NodeDrawer nodeId="MMR-65" offline={false} onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });

    await screen.findByText("Regression task");
    await userEvent.click(screen.getByRole("button", { name: /edit/i }));
    // Save immediately without changing any fields
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    // The PATCH body must NOT include description:null or external_ref:null
    expect(apiSend).toHaveBeenCalledWith(
      "PATCH",
      expect.stringContaining("/api/nodes/"),
      expect.not.objectContaining({ description: null }),
    );
    expect(apiSend).toHaveBeenCalledWith(
      "PATCH",
      expect.stringContaining("/api/nodes/"),
      expect.not.objectContaining({ external_ref: null }),
    );
  });

  test("edit button is absent when offline", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === "/api/nodes/MMR-51") {
        return Promise.resolve(task({ id: "MMR-51", status: "ready", title: "Chunk 2" }));
      }
      if (path === "/api/nodes/MMR-51/annotations") {
        return Promise.resolve({ total: 0, items: [] });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(<NodeDrawer nodeId="MMR-51" offline onClose={vi.fn()} onOpenNode={vi.fn()} />, {
      wrapper,
    });
    await screen.findByText("Chunk 2");
    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
  });

  test("clicking an artifact navigates to the reader with provenance", async () => {
    navigate.mockClear();
    apiGet.mockImplementation((path: string) => {
      if (path === "/api/nodes/MMR-16") {
        return Promise.resolve(
          task({
            id: "MMR-16",
            status: "in_progress",
            title: "chunk 1",
            artifacts: [
              {
                id: "MMR-a3",
                title: "console notes",
                tags: [],
                created_at: "2026-06-10T00:00:00.000Z",
              },
            ],
          }),
        );
      }
      if (path === "/api/nodes/MMR-16/annotations") return Promise.resolve({ total: 0, items: [] });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    render(<NodeDrawer nodeId="MMR-16" onClose={vi.fn()} onOpenNode={vi.fn()} />, { wrapper });
    await userEvent.click(await screen.findByText("console notes"));
    expect(navigate).toHaveBeenCalledWith({
      to: "/artifacts",
      search: { a: "MMR-a3", from: "MMR-16" },
    });
  });
});
