import { describe, expect, test } from "vitest";
import { availableTransitions } from "../lib/transitions";

describe("availableTransitions", () => {
  test("ready offers start + holds + abandon", () => {
    expect(availableTransitions("ready").map((v) => v.verb)).toEqual([
      "start",
      "park",
      "block",
      "abandon",
    ]);
  });

  test("awaiting matches ready (start is legal on a dep-gated todo)", () => {
    expect(availableTransitions("awaiting").map((v) => v.verb)).toEqual(
      availableTransitions("ready").map((v) => v.verb),
    );
  });

  test("in_progress offers submit + done instead of start", () => {
    expect(availableTransitions("in_progress").map((v) => v.verb)).toEqual([
      "submit",
      "done",
      "park",
      "block",
      "abandon",
    ]);
  });

  test("under_review offers approve (done) + request-changes (return) + holds (MMR-84)", () => {
    const specs = availableTransitions("under_review");
    expect(specs.map((v) => v.verb)).toEqual(["done", "return", "park", "block", "abandon"]);
    expect(specs.find((s) => s.verb === "return")?.needsReason).toBe(true);
    expect(specs.find((s) => s.verb === "done")?.needsReason).toBe(false);
  });

  test("held columns offer only their release + abandon", () => {
    expect(availableTransitions("parked").map((v) => v.verb)).toEqual(["unpark", "abandon"]);
    expect(availableTransitions("blocked").map((v) => v.verb)).toEqual(["unblock", "abandon"]);
  });

  test("terminal statuses offer reopen; new offers nothing (MMR-104)", () => {
    expect(availableTransitions("done").map((v) => v.verb)).toEqual(["reopen"]);
    expect(availableTransitions("abandoned").map((v) => v.verb)).toEqual(["reopen"]);
    expect(availableTransitions("done").find((s) => s.verb === "reopen")?.needsReason).toBe(true);
    expect(availableTransitions("new")).toEqual([]);
  });

  test("only park/block/abandon need a reason", () => {
    const reason = (v: string) =>
      availableTransitions("in_progress").find((s) => s.verb === v)?.needsReason;
    expect(reason("park")).toBe(true);
    expect(reason("block")).toBe(true);
    expect(reason("abandon")).toBe(true);
    expect(reason("done")).toBe(false);
  });
});
