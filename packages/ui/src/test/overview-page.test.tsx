import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../api/client", () => ({ apiGet }));

import type { WireAttention } from "../api/types";
import { router } from "../router";

function attn(band: WireAttention["band"], lastActivity: string, stale = false): WireAttention {
  return { band, last_activity: lastActivity, stale };
}

function proj(id: string, attention?: WireAttention) {
  return { id, title: `${id} project`, status: "in_progress", distribution: {}, attention };
}

function renderOverview() {
  const testRouter = createRouter({
    routeTree: router.routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={testRouter} />
    </QueryClientProvider>,
  );
}

describe("OverviewPage attention-router (MMR-102)", () => {
  test("renders the populated bands in highest-wins order, At rest collapsed", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === "/api/projects") {
        return Promise.resolve({
          total: 3,
          items: [
            proj("REVIEW", attn("awaiting_you", "2026-06-20T00:00:00.000Z")),
            proj("LIVE", attn("live", "2026-06-19T00:00:00.000Z")),
            proj("RESTED", attn("at_rest", "2026-06-01T00:00:00.000Z")),
          ],
        });
      }
      return Promise.resolve({ total: 0, items: [] }); // ready + attention strips
    });
    renderOverview();

    expect(await screen.findByText("Awaiting you")).toBeDefined();
    expect(screen.getByText("Live")).toBeDefined();
    // needs_unsticking has no members → its header is omitted
    expect(screen.queryByText("Needs unsticking")).toBeNull();
    // At rest is collapsed: a "view all" strip, its card hidden until expanded
    expect(screen.queryByText("RESTED")).toBeNull();
    const strip = screen.getByRole("button", { name: /at rest/i });
    await userEvent.click(strip);
    expect(screen.getByText("RESTED")).toBeDefined();
  });

  test("degrades to a flat Overview grid when the attention facet is absent", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === "/api/projects") {
        return Promise.resolve({ total: 1, items: [proj("OLDCACHE")] }); // no attention
      }
      return Promise.resolve({ total: 0, items: [] });
    });
    renderOverview();

    expect(await screen.findByText("Overview")).toBeDefined();
    expect(screen.getByText("OLDCACHE")).toBeDefined();
    expect(screen.queryByText("Awaiting you")).toBeNull();
  });

  test("shows an empty state when there are no projects", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path === "/api/projects") return Promise.resolve({ total: 0, items: [] });
      return Promise.resolve({ total: 0, items: [] });
    });
    renderOverview();

    expect(await screen.findByText(/no projects yet/i)).toBeDefined();
  });
});
