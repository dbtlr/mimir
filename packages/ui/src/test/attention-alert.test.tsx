import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../api/client", () => ({ apiGet }));

import { router } from "../router";

/** MMR-103 — the top-bar alert counts under_review + blocked + stale ("needs you"). */
function renderApp() {
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

describe("AttentionAlert (MMR-103)", () => {
  test("counts under_review + blocked + stale in the 'needs you' badge", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.includes("status=under_review"))
        return Promise.resolve({ total: 2, items: [{ id: "MMR-2" }, { id: "MMR-3" }] });
      if (path.includes("status=blocked"))
        return Promise.resolve({ total: 1, items: [{ id: "MMR-5" }] });
      if (path.includes("is=stale"))
        return Promise.resolve({ total: 1, items: [{ id: "MMR-9", status: "ready" }] });
      return Promise.resolve({ total: 0, items: [] }); // projects, ready, etc.
    });
    renderApp();
    // 2 + 1 + 1 = 4 distinct items
    expect(await screen.findByRole("button", { name: "Attention: 4 need you" })).toBeDefined();
  });

  test("reads 'nothing needs you' when the set is empty", async () => {
    apiGet.mockImplementation(() => Promise.resolve({ total: 0, items: [] }));
    renderApp();
    expect(
      await screen.findByRole("button", { name: "Attention: nothing needs you" }),
    ).toBeDefined();
  });

  test("uses the singular 'needs' at a count of one", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.includes("status=under_review"))
        return Promise.resolve({ total: 1, items: [{ id: "MMR-2" }] });
      return Promise.resolve({ total: 0, items: [] });
    });
    renderApp();
    expect(await screen.findByRole("button", { name: "Attention: 1 needs you" })).toBeDefined();
  });
});
