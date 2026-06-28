import type { WireAttention, WireNode } from "../api/types";

let seq = 100;

/** A project record as the overview list serves it; pass `attention` for band tests. */
export function project(
  overrides: Partial<WireNode> & { attention?: WireAttention } = {},
): WireNode {
  seq += 1;
  const id = overrides.id ?? `P${String(seq)}`;
  return {
    id,
    type: "project",
    title: `project ${id}`,
    status: "in_progress",
    parent: null,
    description: null,
    created_at: "2026-06-01T10:00:00.000Z",
    updated_at: "2026-06-01T10:00:00.000Z",
    distribution: {},
    ...overrides,
  };
}

/** A task record as the wire serves it; override what the case needs. */
export function task(overrides: Partial<WireNode> & { status: WireNode["status"] }): WireNode {
  seq += 1;
  const id = overrides.id ?? `MMR-${String(seq)}`;
  return {
    id,
    type: "task",
    title: `task ${id}`,
    parent: "MMR-1",
    description: null,
    priority: null,
    size: null,
    lifecycle: "todo",
    hold: "none",
    hold_reason: null,
    external_ref: null,
    completed_at: null,
    created_at: "2026-06-01T10:00:00.000Z",
    updated_at: "2026-06-01T10:00:00.000Z",
    deps: { depends_on: [], blocking: [] },
    tags: [],
    distribution: {},
    verdicts: { stale: false, blocking: false, orphaned: false },
    ...overrides,
  };
}

export const NOW = Date.parse("2026-06-11T12:00:00.000Z");

/** ISO timestamp `days` days before {@link NOW}. */
export function daysAgo(days: number): string {
  return new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
}
