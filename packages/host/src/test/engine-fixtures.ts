// Shared test fixtures module, not a test body.
// oxlint-disable vitest/require-hook
import type { ConsoleOutput, EngineNode, EngineSearchHit, EngineTree } from '@mimir/contract';

/*
 * Engine-shaped records for the reads that run through server functions: the
 * Engine's own output types, with `Date` instants. The `/api` wire fixtures in
 * fixtures.ts serve the reads not yet migrated.
 */

/** The instant every fixture record was created and last updated. */
export const FIXTURE_AT = new Date('2026-06-01T10:00:00.000Z');

let seq = 100;

/** A node record of any type as the Engine returns it; override what the case needs. */
export function engineNode(
  overrides: Partial<EngineNode> & Pick<EngineNode, 'type' | 'status'>,
): EngineNode {
  seq += 1;
  const id = overrides.id ?? `MMR-${String(seq)}`;
  return {
    createdAt: FIXTURE_AT,
    id,
    parent: 'MMR',
    title: `${overrides.type} ${id}`,
    updatedAt: FIXTURE_AT,
    ...overrides,
  };
}

/** A project record as the project list serves it. */
export function engineProject(overrides: Partial<EngineNode> = {}): EngineNode {
  seq += 1;
  const id = overrides.id ?? `P${String(seq)}`;
  return {
    createdAt: FIXTURE_AT,
    description: null,
    distribution: {},
    id,
    parent: null,
    pinned: false,
    status: 'in_progress',
    title: `project ${id}`,
    type: 'project',
    updatedAt: FIXTURE_AT,
    ...overrides,
  };
}

/** A tree node with its nested children, as `tree` returns it. */
export function engineTree(
  node: Omit<Partial<EngineTree>, 'children'> & Pick<EngineTree, 'id' | 'type' | 'status'>,
  children: EngineTree[] = [],
): EngineTree {
  return {
    createdAt: FIXTURE_AT,
    parent: null,
    title: `${node.type} ${node.id}`,
    updatedAt: FIXTURE_AT,
    ...node,
    children,
  };
}

/** One search hit, a task's title match unless the case says otherwise. */
export function searchHit(
  overrides: Partial<EngineSearchHit> & Pick<EngineSearchHit, 'id'>,
): EngineSearchHit {
  return {
    finished: false,
    kind: 'task',
    lifecycle: 'todo',
    match: 'title',
    project: overrides.id.split('-')[0] ?? 'MMR',
    title: `task ${overrides.id}`,
    updatedAt: FIXTURE_AT,
    ...overrides,
  };
}

/** A search answer holding `hits`, as `console.search` returns it. */
export function searchSet(hits: EngineSearchHit[] = []): ConsoleOutput<'search'> {
  return { items: hits, returned: hits.length, startsAt: 0, total: hits.length };
}
