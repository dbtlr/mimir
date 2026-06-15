import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { TransitionMenu } from "../components/transition-menu";

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("../api/mutations", () => ({
  useTransition: () => ({ mutate }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe("TransitionMenu", () => {
  test("renders nothing for a terminal status", () => {
    const { container } = render(<TransitionMenu node={{ id: "MMR-9", status: "done" }} />, {
      wrapper,
    });
    expect(container.querySelector("[aria-label='Actions']")).toBeNull();
  });

  test("immediate verb fires the mutation directly", async () => {
    render(<TransitionMenu node={{ id: "MMR-9", status: "ready" }} />, { wrapper });
    await userEvent.click(screen.getByLabelText("Actions"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Start" }));
    expect(mutate).toHaveBeenCalledWith({ verb: "start" });
  });

  test("reason verb opens the dialog, then mutates with the reason", async () => {
    render(<TransitionMenu node={{ id: "MMR-9", status: "ready" }} />, { wrapper });
    await userEvent.click(screen.getByLabelText("Actions"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Park" }));
    await userEvent.type(await screen.findByRole("textbox"), "later");
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(mutate).toHaveBeenCalledWith({ verb: "park", reason: "later" });
  });

  test("disabled hides the trigger action", () => {
    render(<TransitionMenu node={{ id: "MMR-9", status: "ready" }} disabled />, { wrapper });
    expect(screen.getByLabelText("Actions")).toHaveProperty("disabled", true);
  });
});
