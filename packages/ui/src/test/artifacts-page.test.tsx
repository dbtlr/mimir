import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../api/client", () => ({ apiGet }));

import { router } from "../router";

describe("ArtifactsPage", () => {
  test("renders the filter search box and the result rows", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith("/api/projects")) {
        return Promise.resolve({ total: 1, items: [{ id: "MMR", status: "ready" }] });
      }
      if (path === "/api/artifacts" || path.startsWith("/api/artifacts?")) {
        return Promise.resolve({
          total: 1,
          items: [
            {
              id: "MMR-a8",
              title: "Artifacts browser",
              project: "MMR",
              tags: ["kind:spec"],
              created_at: "2026-06-16T00:00:00.000Z",
            },
          ],
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    const testRouter = createRouter({
      routeTree: router.routeTree,
      history: createMemoryHistory({ initialEntries: ["/artifacts"] }),
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={testRouter} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Artifacts browser")).toBeDefined();
    expect(screen.getByPlaceholderText(/search title and body/i)).toBeDefined();
  });
});
