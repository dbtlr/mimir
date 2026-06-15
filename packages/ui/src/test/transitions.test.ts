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

  test("in_progress offers done instead of start", () => {
    expect(availableTransitions("in_progress").map((v) => v.verb)).toEqual([
      "done",
      "park",
      "block",
      "abandon",
    ]);
  });

  test("held columns offer only their release + abandon", () => {
    expect(availableTransitions("parked").map((v) => v.verb)).toEqual(["unpark", "abandon"]);
    expect(availableTransitions("blocked").map((v) => v.verb)).toEqual(["unblock", "abandon"]);
  });

  test("terminal/non-board statuses offer nothing", () => {
    expect(availableTransitions("done")).toEqual([]);
    expect(availableTransitions("abandoned")).toEqual([]);
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
