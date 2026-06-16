import { describe, expect, test } from "vitest";
import { buildAncestry } from "../lib/ancestry";
import type { WireTreeNode } from "../api/types";

const tree = {
  id: "MMR",
  type: "project",
  title: "Mimir",
  children: [
    {
      id: "MMR-1",
      type: "initiative",
      title: "Build",
      children: [
        {
          id: "MMR-7",
          type: "phase",
          title: "Phase 5",
          children: [{ id: "MMR-16", type: "task", title: "read-only", children: [] }],
        },
        { id: "MMR-99", type: "task", title: "phaseless task", children: [] },
      ],
    },
  ],
} as unknown as WireTreeNode;

describe("buildAncestry", () => {
  test("labels a task with its initiative › phase breadcrumb", () => {
    expect(buildAncestry(tree).get("MMR-16")).toBe("Build › Phase 5");
  });

  test("a task directly under an initiative shows just the initiative", () => {
    expect(buildAncestry(tree).get("MMR-99")).toBe("Build");
  });

  test("the project root is excluded; an initiative has an empty breadcrumb", () => {
    const a = buildAncestry(tree);
    expect(a.get("MMR-1")).toBe("");
    expect(a.get("MMR-7")).toBe("Build");
  });
});
