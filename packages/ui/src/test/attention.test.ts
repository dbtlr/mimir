import { describe, expect, test } from "vitest";
import { attentionItems } from "../lib/attention";
import { task } from "./fixtures";

const staleV = { stale: true, blocking: false, orphaned: false };

describe("attentionItems (MMR-103: under_review + blocked + stale)", () => {
  test("under_review leads, then blocked, then stale; ids dedupe across reads", () => {
    const review = task({ id: "MMR-2", status: "under_review" });
    const blockedStale = task({ id: "MMR-4", status: "blocked", verdicts: staleV });
    const staleReady = task({ id: "MMR-8", status: "ready", verdicts: staleV });

    const items = attentionItems(
      [review],
      [blockedStale],
      [blockedStale, staleReady], // blockedStale also surfaced by the stale read — dedupe
    );

    // ordering by "how much your action moves it": review → blocked → stale
    expect(items.map((i) => i.node.id)).toEqual(["MMR-2", "MMR-4", "MMR-8"]);
    expect(items[0]?.reason).toBe("under_review");
    expect(items[1]?.reason).toBe("blocked");
    expect(items[1]?.stale).toBe(true); // kept its blocked reason, flagged stale too
    expect(items[2]?.reason).toBe("ready");
    expect(items[2]?.stale).toBe(true);
  });

  test("a stale under_review task shows once — reason under_review, stale rides as a marker", () => {
    const reviewStale = task({ id: "MMR-3", status: "under_review", verdicts: staleV });
    const items = attentionItems([reviewStale], [], [reviewStale]);
    expect(items.map((i) => i.node.id)).toEqual(["MMR-3"]);
    expect(items[0]?.reason).toBe("under_review");
    expect(items[0]?.stale).toBe(true);
  });

  test("empty when nothing needs attention", () => {
    expect(attentionItems([], [], [])).toEqual([]);
  });
});
