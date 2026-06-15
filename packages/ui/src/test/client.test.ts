import { afterEach, describe, expect, test, vi } from "vitest";
import { apiSend } from "../api/client";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("apiSend", () => {
  test("POSTs JSON and returns the parsed body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "MMR-9" }), { status: 200 }));
    const out = await apiSend<{ id: string }>("POST", "/api/nodes/MMR-9/start");
    expect(out).toEqual({ id: "MMR-9" });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
  });

  test("sends a JSON body when given one", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await apiSend("POST", "/api/nodes/MMR-9/park", { reason: "waiting" });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBe(JSON.stringify({ reason: "waiting" }));
  });

  test("throws the error envelope's message on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "validation", message: "already done" } }), {
        status: 400,
      }),
    );
    await expect(apiSend("POST", "/api/nodes/MMR-9/done")).rejects.toThrow("already done");
  });
});
