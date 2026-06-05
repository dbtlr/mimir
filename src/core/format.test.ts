import { describe, expect, test } from "bun:test";
import type { NodeView, SetResult } from "../contract/dto";
import {
  formatIds,
  formatNodeJson,
  formatSetJson,
  formatSetJsonl,
  formatStatusJson,
} from "./format";

const task = (id: string, over: Partial<NodeView> = {}): NodeView => ({
  id,
  type: "task",
  title: `title ${id}`,
  state: "ready",
  parent: "MMR-1",
  description: null,
  createdAt: "2026-06-05T00:00:00.000Z",
  updatedAt: "2026-06-05T00:00:00.000Z",
  priority: "p1",
  size: null,
  lifecycle: "todo",
  hold: "none",
  holdReason: null,
  externalRef: null,
  completedAt: null,
  ...over,
});

const set = (items: NodeView[]): SetResult<NodeView> => ({
  total: items.length,
  returned: items.length,
  startsAt: 0,
  items,
});

describe("formatIds", () => {
  test("one id per line", () => {
    expect(formatIds([task("MMR-2"), task("MMR-3")])).toBe("MMR-2\nMMR-3");
    expect(formatIds([])).toBe("");
  });
});

describe("formatSetJson", () => {
  test("count-led envelope with the unit key and snake_case fields", () => {
    const parsed = JSON.parse(formatSetJson(set([task("MMR-2", { holdReason: "x" })]))) as {
      total: number;
      returned: number;
      starts_at: number;
      tasks: { id: string; hold_reason: string }[];
    };
    expect(parsed.total).toBe(1);
    expect(parsed.starts_at).toBe(0);
    expect(parsed.tasks[0]?.id).toBe("MMR-2");
    expect(parsed.tasks[0]?.hold_reason).toBe("x"); // camelCase DTO -> snake_case wire
  });

  test("unit key is configurable", () => {
    const parsed = JSON.parse(formatSetJson(set([]), "nodes")) as Record<string, unknown>;
    expect(parsed.nodes).toEqual([]);
  });
});

describe("formatSetJsonl", () => {
  test("one object per line, no wrapper", () => {
    const lines = formatSetJsonl([task("MMR-2"), task("MMR-3")]).split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0] ?? "{}") as { id: string }).id).toBe("MMR-2");
  });
});

describe("formatNodeJson", () => {
  test("bare object (no set wrapper), only defined fields", () => {
    const parsed = JSON.parse(formatNodeJson(task("MMR-2", { externalRef: "gh#9" }))) as Record<
      string,
      unknown
    >;
    expect(parsed.id).toBe("MMR-2");
    expect(parsed.external_ref).toBe("gh#9");
    expect("total" in parsed).toBe(false);
  });

  test("phase omits task-only fields, includes target", () => {
    const phase: NodeView = {
      id: "MMR-1",
      type: "phase",
      title: "ph",
      state: "ready",
      parent: null,
      description: null,
      createdAt: "2026-06-05T00:00:00.000Z",
      updatedAt: "2026-06-05T00:00:00.000Z",
      target: "ship",
    };
    const parsed = JSON.parse(formatNodeJson(phase)) as Record<string, unknown>;
    expect(parsed.target).toBe("ship");
    expect("priority" in parsed).toBe(false);
    expect("hold" in parsed).toBe(false);
  });
});

describe("formatStatusJson", () => {
  test("id, state, and distribution", () => {
    const parsed = JSON.parse(
      formatStatusJson({
        id: "MMR-1",
        state: "in_progress",
        distribution: { in_progress: 1, ready: 2 },
      }),
    ) as { id: string; state: string; distribution: Record<string, number> };
    expect(parsed.state).toBe("in_progress");
    expect(parsed.distribution).toEqual({ in_progress: 1, ready: 2 });
  });
});
