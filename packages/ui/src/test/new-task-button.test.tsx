import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { ReactNode } from "react";
import { NewTaskButton } from "../components/new-task-button";

function wrap(ui: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("NewTaskButton", () => {
  test("is disabled when offline", () => {
    wrap(<NewTaskButton projectKey="MMR" offline />);
    expect(screen.getByRole("button", { name: /new task/i })).toBeDisabled();
  });

  test("is enabled when online", () => {
    wrap(<NewTaskButton projectKey="MMR" offline={false} />);
    expect(screen.getByRole("button", { name: /new task/i })).toBeEnabled();
  });
});
