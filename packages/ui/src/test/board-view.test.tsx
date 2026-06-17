import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { BoardView } from "../components/board";
import { buildBoard } from "../lib/board";
import { NOW, daysAgo, task } from "./fixtures";

vi.mock("../api/mutations", () => ({
  useTransition: () => ({ mutate: vi.fn() }),
  useReorder: () => ({ mutate: vi.fn() }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe("BoardView", () => {
  test("cards land in their status-word column, Ready in given order", () => {
    const board = buildBoard(
      [
        task({ id: "MMR-9", status: "ready", title: "queued first" }),
        task({ id: "MMR-2", status: "in_progress", title: "being built" }),
        task({ id: "MMR-7", status: "ready", title: "queued second" }),
        task({ id: "MMR-4", status: "blocked", title: "stuck on review" }),
      ],
      [task({ id: "MMR-50", status: "done", title: "shipped", completed_at: daysAgo(2) })],
      NOW,
    );
    render(<BoardView board={board} onOpenNode={vi.fn()} doneTotal={1} onViewDone={vi.fn()} />, {
      wrapper,
    });

    // desktop sections are labelled by their status word
    const [ready] = screen.getAllByRole("region", { name: "Ready" });
    expect(ready).toBeDefined();
    const readyCards = within(ready as HTMLElement).getAllByRole("listitem");
    expect(readyCards.map((c) => c.textContent)).toEqual([
      expect.stringContaining("MMR-9"),
      expect.stringContaining("MMR-7"),
    ]);

    const [inProgress] = screen.getAllByRole("region", { name: "In progress" });
    expect(within(inProgress as HTMLElement).getByText("being built")).toBeDefined();

    const [done] = screen.getAllByRole("region", { name: "Done" });
    expect(within(done as HTMLElement).getByText("shipped")).toBeDefined();
  });

  test("a stale in-flight card carries the stale marker", () => {
    const board = buildBoard(
      [
        task({
          id: "MMR-3",
          status: "in_progress",
          verdicts: { stale: true, blocking: false, orphaned: false },
        }),
      ],
      [],
      NOW,
    );
    render(<BoardView board={board} onOpenNode={vi.fn()} doneTotal={1} onViewDone={vi.fn()} />, {
      wrapper,
    });
    expect(screen.getAllByText(/stale/).length).toBeGreaterThan(0);
  });

  test("clicking a card opens its node", async () => {
    const onOpen = vi.fn();
    const board = buildBoard([task({ id: "MMR-8", status: "ready", title: "open me" })], [], NOW);
    render(<BoardView board={board} onOpenNode={onOpen} doneTotal={0} onViewDone={vi.fn()} />, {
      wrapper,
    });
    screen.getAllByText("open me")[0]?.closest("button")?.click();
    expect(onOpen).toHaveBeenCalledWith("MMR-8");
  });
});
