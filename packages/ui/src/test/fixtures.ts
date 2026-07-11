// Shared test fixtures module, not a test body.
// oxlint-disable vitest/require-hook
import type { WireAttention, WireNode, WireSeed } from '../api/types';

let seq = 100;

/** A project record as the overview list serves it; pass `attention` for lane tests. */
export function project(
  overrides: Partial<WireNode> & { attention?: WireAttention } = {},
): WireNode {
  seq += 1;
  const id = overrides.id ?? `P${String(seq)}`;
  return {
    created_at: '2026-06-01T10:00:00.000Z',
    description: null,
    distribution: {},
    id,
    parent: null,
    status: 'in_progress',
    title: `project ${id}`,
    type: 'project',
    updated_at: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

/** A task record as the wire serves it; override what the case needs. */
export function task(overrides: Partial<WireNode> & { status: WireNode['status'] }): WireNode {
  seq += 1;
  const id = overrides.id ?? `MMR-${String(seq)}`;
  return {
    completed_at: null,
    created_at: '2026-06-01T10:00:00.000Z',
    deps: { blocking: [], depends_on: [] },
    description: null,
    distribution: {},
    external_ref: null,
    hold: 'none',
    hold_reason: null,
    id,
    lifecycle: 'todo',
    parent: 'MMR-1',
    priority: null,
    size: null,
    tags: [],
    title: `task ${id}`,
    type: 'task',
    updated_at: '2026-06-01T10:00:00.000Z',
    verdicts: { blocking: false, orphaned: false, stale: false },
    ...overrides,
  };
}

/** A seed record as the wire serves it (MMR-247); override what the case needs. */
export function seed(overrides: Partial<WireSeed> & { lane: WireSeed['lane'] }): WireSeed {
  seq += 1;
  const id = overrides.id ?? `MMR-s${String(seq)}`;
  return {
    created_at: '2026-06-01T10:00:00.000Z',
    id,
    kind: 'idea',
    lifecycle: 'new',
    project: 'MMR',
    ready_to_resolve: false,
    requester: null,
    spawned: [],
    title: `seed ${id}`,
    updated_at: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

export const NOW = Date.parse('2026-06-11T12:00:00.000Z');

/** ISO timestamp `days` days before {@link NOW}. */
export function daysAgo(days: number): string {
  return new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
}
