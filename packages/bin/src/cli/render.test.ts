import { expect, test } from "bun:test";
import type { NodeView } from "@mimir/contract";
import { renderTable } from "./render";
import { fakeIo } from "./testing";

function task(over: Partial<NodeView> = {}): NodeView {
  return {
    id: "MMR-5",
    type: "task",
    title: "child",
    status: "ready",
    parent: "MMR-2",
    description: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    priority: "p1",
    ...over,
  };
}

test("table set view shows the parent id as a row column (MMR-87)", () => {
  const text = renderTable({ total: 1, returned: 1, startsAt: 0, items: [task()] }, fakeIo(false));
  expect(text).toContain("MMR-5"); // the node id
  expect(text).toContain("MMR-2"); // its parent, the hierarchy anchor
  expect(text).toContain("child"); // the title
});

test("a top-level node (no parent) renders an empty parent cell, not a crash (MMR-87)", () => {
  const text = renderTable(
    { total: 1, returned: 1, startsAt: 0, items: [task({ id: "MMR-1", parent: null })] },
    fakeIo(false),
  );
  expect(text).toContain("MMR-1");
  expect(text).toContain("child");
});
