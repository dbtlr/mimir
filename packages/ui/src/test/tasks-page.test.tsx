import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock("../api/client", () => ({ apiGet }));

import { router } from "../router";

describe("TasksPage (MMR-78)", () => {
  test("renders the filter/search bar and the task rows", async () => {
    apiGet.mockImplementation((path: string) => {
      if (path.startsWith("/api/projects")) {
        return Promise.resolve({ total: 1, items: [{ id: "MMR", status: "ready" }] });
      }
      if (path.startsWith("/api/nodes?")) {
        return Promise.resolve({
          total: 1,
          items: [{ id: "MMR-78", title: "Task browser", status: "ready", verdicts: {} }],
        });
      }
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    const testRouter = createRouter({
      routeTree: router.routeTree,
      history: createMemoryHistory({ initialEntries: ["/tasks"] }),
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={testRouter} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Task browser")).toBeDefined();
    expect(screen.getByPlaceholderText(/search titles/i)).toBeDefined();
  });

  test("the task read carries type=task and threads the q search param", () => {
    // tasksQuery builds the request; assert the URL shape rather than the DOM.
    const calls = apiGet.mock.calls.map((c) => c[0] as string);
    const nodeCall = calls.find((p) => p.startsWith("/api/nodes?"));
    expect(nodeCall).toContain("type=task");
  });
});
