import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { NodeCard } from "../components/node-card";
import { task } from "./fixtures";

vi.mock("../api/mutations", () => ({ useTransition: () => ({ mutate: vi.fn() }) }));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe("NodeCard", () => {
  test("opens the node when the title region is clicked", async () => {
    const onOpen = vi.fn();
    render(<NodeCard node={task({ id: "MMR-9", status: "ready" })} onOpen={onOpen} />, { wrapper });
    await userEvent.click(screen.getByText("task MMR-9"));
    expect(onOpen).toHaveBeenCalledWith("MMR-9");
  });

  test("shows the actions kebab for a live card", () => {
    render(<NodeCard node={task({ id: "MMR-9", status: "ready" })} onOpen={vi.fn()} />, {
      wrapper,
    });
    expect(screen.getByLabelText("Actions")).toBeDefined();
  });

  test("offline disables the actions kebab", () => {
    render(<NodeCard node={task({ id: "MMR-9", status: "ready" })} onOpen={vi.fn()} offline />, {
      wrapper,
    });
    expect(screen.getByLabelText("Actions")).toHaveProperty("disabled", true);
  });

  test("a done card has no kebab", () => {
    render(<NodeCard node={task({ id: "MMR-9", status: "done" })} onOpen={vi.fn()} />, { wrapper });
    expect(screen.queryByLabelText("Actions")).toBeNull();
  });

  test("shows the ancestry breadcrumb when provided", () => {
    render(
      <NodeCard
        node={task({ id: "MMR-9", status: "ready" })}
        onOpen={vi.fn()}
        ancestry="Build › Phase 5"
      />,
      { wrapper },
    );
    expect(screen.getByText("Build › Phase 5")).toBeDefined();
  });

  test("renders no breadcrumb when ancestry is empty or absent", () => {
    render(
      <NodeCard node={task({ id: "MMR-9", status: "ready" })} onOpen={vi.fn()} ancestry="" />,
      { wrapper },
    );
    expect(screen.queryByText("Build › Phase 5")).toBeNull();
  });

  const sortable = { setNodeRef: () => {}, handleProps: {} };

  test("renders the grip handle when sortable", () => {
    render(
      <NodeCard
        node={task({ id: "MMR-9", status: "ready" })}
        onOpen={vi.fn()}
        sortable={sortable}
      />,
      {
        wrapper,
      },
    );
    expect(screen.getByLabelText("Reorder")).toBeDefined();
  });

  test("offline hides the grip handle even when sortable", () => {
    render(
      <NodeCard
        node={task({ id: "MMR-9", status: "ready" })}
        onOpen={vi.fn()}
        sortable={sortable}
        offline
      />,
      { wrapper },
    );
    expect(screen.queryByLabelText("Reorder")).toBeNull();
  });

  test("no grip when not sortable (held/done columns)", () => {
    render(<NodeCard node={task({ id: "MMR-9", status: "ready" })} onOpen={vi.fn()} />, {
      wrapper,
    });
    expect(screen.queryByLabelText("Reorder")).toBeNull();
  });
});
