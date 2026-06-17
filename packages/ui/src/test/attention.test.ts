import { describe, expect, test } from "vitest";
import { attentionItems } from "../lib/attention";
import { task } from "./fixtures";

describe("attentionItems (MMR-80: blocked + stale, no in-flight)", () => {
  test("blocked leads, stale follows, ids dedupe across the two reads", () => {
    const blockedAndStale = task({
      id: "MMR-4",
      status: "blocked",
      verdicts: { stale: true, blocking: false, orphaned: false },
    });
    const items = attentionItems(
      [blockedAndStale],
      [
        blockedAndStale, // also surfaced by the stale read — must dedupe
        task({
          id: "MMR-8",
          status: "ready",
          verdicts: { stale: true, blocking: false, orphaned: false },
        }),
      ],
    );
    expect(items.map((i) => i.node.id)).toEqual(["MMR-4", "MMR-8"]);
    // MMR-4 keeps its blocked reason but is flagged stale too
    expect(items[0]?.reason).toBe("blocked");
    expect(items[0]?.stale).toBe(true);
    // MMR-8 is stale-only
    expect(items[1]?.reason).toBe("ready");
    expect(items[1]?.stale).toBe(true);
  });

  test("empty when nothing is stuck", () => {
    expect(attentionItems([], [])).toEqual([]);
  });
});
