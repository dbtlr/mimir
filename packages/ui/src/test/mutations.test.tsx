import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { useReorder, useTransition } from "../api/mutations";

const { apiSend } = vi.hoisted(() => ({ apiSend: vi.fn() }));
vi.mock("../api/client", () => ({ apiSend }));
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn() } }));
vi.mock("sonner", () => ({ toast }));

afterEach(() => {
  vi.clearAllMocks();
});

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("mutation hooks", () => {
  test("useTransition POSTs the verb route, no body for plain verbs", async () => {
    apiSend.mockResolvedValue({ id: "MMR-9" });
    const client = new QueryClient();
    const { result } = renderHook(() => useTransition("MMR-9"), { wrapper: wrapper(client) });
    result.current.mutate({ verb: "start" });
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith("POST", "/api/nodes/MMR-9/start", undefined);
    });
  });

  test("useTransition sends a reason body for reason verbs", async () => {
    apiSend.mockResolvedValue({ id: "MMR-9" });
    const client = new QueryClient();
    const { result } = renderHook(() => useTransition("MMR-9"), { wrapper: wrapper(client) });
    result.current.mutate({ verb: "park", reason: "  waiting  " });
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith("POST", "/api/nodes/MMR-9/park", { reason: "waiting" });
    });
  });

  test("useReorder POSTs the reorder route with the id given at mutate time", async () => {
    apiSend.mockResolvedValue({ id: "MMR-9" });
    const client = new QueryClient();
    const { result } = renderHook(() => useReorder(), { wrapper: wrapper(client) });
    result.current.mutate({ id: "MMR-9", after: "MMR-3" });
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith("POST", "/api/nodes/MMR-9/reorder", { after: "MMR-3" });
    });
  });

  test("invalidates board queries on settle", async () => {
    apiSend.mockResolvedValue({ id: "MMR-9" });
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useTransition("MMR-9"), { wrapper: wrapper(client) });
    result.current.mutate({ verb: "done" });
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ["board"] });
    });
  });

  test("toasts the error message on failure", async () => {
    apiSend.mockRejectedValue(new Error("already done"));
    const client = new QueryClient();
    const { result } = renderHook(() => useTransition("MMR-9"), { wrapper: wrapper(client) });
    result.current.mutate({ verb: "done" });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("already done");
    });
  });
});
