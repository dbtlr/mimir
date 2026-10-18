// Shared test fixtures module, not a test body.
// oxlint-disable vitest/require-hook
import type { EngineNode, EngineOutput } from '@mimir/contract';

import { FIXTURE_AT } from './engine-fixtures';

/*
 * Node records as the Engine's `getNode` returns them (MMR-539): the Engine's
 * own camelCase output with `Date` instants, carrying the facets the console's
 * node read asks for.
 */

let seq = 500;

/** A task record with the node read's facets; override what the case needs. */
export function engineTask(
  overrides: Partial<EngineNode> & Pick<EngineNode, 'status'>,
): EngineNode {
  seq += 1;
  const id = overrides.id ?? `MMR-${String(seq)}`;
  return {
    completedAt: null,
    createdAt: FIXTURE_AT,
    deps: { awaitingOn: [], blocking: [], dependsOn: [] },
    description: null,
    distribution: {},
    externalRef: null,
    hold: 'none',
    holdReason: null,
    id,
    lifecycle: 'todo',
    parent: 'MMR-1',
    priority: null,
    size: null,
    tags: [],
    title: `task ${id}`,
    type: 'task',
    updatedAt: FIXTURE_AT,
    verdicts: { blocking: false, orphaned: false, stale: false },
    ...overrides,
  };
}

/** An initiative or phase record with the node read's facets. */
export function engineContainer(
  overrides: Partial<EngineNode> & Pick<EngineNode, 'status' | 'type'>,
): EngineNode {
  seq += 1;
  const id = overrides.id ?? `MMR-${String(seq)}`;
  return {
    createdAt: FIXTURE_AT,
    deps: { awaitingOn: [], blocking: [], dependsOn: [] },
    description: null,
    distribution: {},
    id,
    parent: 'MMR',
    tags: [],
    title: `${overrides.type} ${id}`,
    updatedAt: FIXTURE_AT,
    ...overrides,
  };
}

/** One freeform note, written at `at`. */
export function engineNote(content: string, at = '2026-06-02T00:00:00.000Z') {
  return { content, createdAt: new Date(at) };
}

/** One tag on a node. */
export function engineTag(tag: string, at = '2026-06-01T00:00:00.000Z') {
  return { createdAt: new Date(at), tag };
}

export type ScratchpadRow = EngineOutput<'scratchList'>[number];

/** One active Scratchpad row on a board. */
export function scratchpadRow(
  overrides: Partial<ScratchpadRow> & Pick<ScratchpadRow, 'id' | 'linkedWork'>,
): ScratchpadRow {
  return {
    openAgenda: 0,
    project: 'MMR',
    state: 'active',
    title: `scratchpad ${overrides.id}`,
    updatedAt: FIXTURE_AT,
    ...overrides,
  };
}
