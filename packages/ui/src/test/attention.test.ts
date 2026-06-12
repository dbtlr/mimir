import { describe, expect, test } from "vitest";
import { attentionItems } from "../components/attention-strip";
import { task } from "./fixtures";

describe("attentionItems", () => {
  test("in-flight leads, stuck follows, ids dedupe across reads", () => {
    const stale = task({
      id: "MMR-2",
      status: "in_progress",
      verdicts: { stale: true, blocking: false, orphaned: false },
    });
    const items = attentionItems(
      [task({ id: "MMR-1", status: "in_progress" }), stale],
      [task({ id: "MMR-4", status: "blocked" })],
      [
        stale,
        task({
          id: "MMR-8",
          status: "ready",
          verdicts: { stale: true, blocking: false, orphaned: false },
        }),
      ],
    );
    expect(items.map((i) => i.node.id)).toEqual(["MMR-1", "MMR-2", "MMR-4", "MMR-8"]);
    expect(items[1]?.stale).toBe(true);
    expect(items[0]?.stale).toBe(false);
  });
});
