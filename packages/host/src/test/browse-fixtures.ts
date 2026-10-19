// Shared test fixtures module, not a test body.
// oxlint-disable vitest/require-hook
import type { EngineNode, SeedLane } from '@mimir/contract';

import type { ArtifactRecord, ArtifactSummary, EngineSeed, TaskSet } from '../api/browse-queries';
import type { RecordHealth } from '../api/fns/browse';
import { engineNode, FIXTURE_AT } from './engine-fixtures';

/*
 * Engine-shaped records for the browsers' reads (MMR-540): seeds, artifacts,
 * task sets, and the record-health facet, with `Date` instants. Node records
 * come from engine-fixtures.ts's `engineNode`.
 */

let seq = 500;

/** A seed as the Engine reads it: an untriaged idea unless the case says otherwise. */
export function engineSeed(overrides: Partial<EngineSeed> = {}): EngineSeed {
  seq += 1;
  const id = overrides.id ?? `MMR-s${String(seq)}`;
  return {
    createdAt: FIXTURE_AT,
    id,
    kind: 'idea',
    lifecycle: 'new',
    project: 'MMR',
    readyToResolve: false,
    requester: null,
    spawned: [],
    title: `seed ${id}`,
    updatedAt: FIXTURE_AT,
    ...overrides,
  };
}

/** The lifecycle and ready flag that put a seed in each lane. */
const LANE_STANDING: Record<SeedLane, Pick<EngineSeed, 'lifecycle' | 'readyToResolve'>> = {
  parked: { lifecycle: 'parked', readyToResolve: false },
  promoted: { lifecycle: 'promoted', readyToResolve: false },
  ready: { lifecycle: 'promoted', readyToResolve: true },
  settled: { lifecycle: 'resolved', readyToResolve: false },
  untriaged: { lifecycle: 'new', readyToResolve: false },
};

/** A seed standing in `lane`; override what the case needs. */
export function seedIn(lane: SeedLane, overrides: Partial<EngineSeed> = {}): EngineSeed {
  return engineSeed({ ...LANE_STANDING[lane], ...overrides });
}

/** An artifact-browser row as `artifacts` returns it. */
export function engineArtifact(
  overrides: Partial<ArtifactSummary> & Pick<ArtifactSummary, 'id'>,
): ArtifactSummary {
  return {
    createdAt: FIXTURE_AT,
    links: [],
    project: overrides.id.split('-')[0] ?? 'MMR',
    tags: [],
    title: `artifact ${overrides.id}`,
    ...overrides,
  };
}

/** One artifact with its body, as `getArtifact` returns it with `content`. */
export function engineArtifactRecord(
  overrides: Partial<ArtifactRecord> & Pick<ArtifactRecord, 'id'>,
): ArtifactRecord {
  return {
    content: '# Body',
    createdAt: FIXTURE_AT,
    links: [],
    project: overrides.id.split('-')[0] ?? 'MMR',
    tags: [],
    title: `artifact ${overrides.id}`,
    ...overrides,
  };
}

/** A todo task as a list row reads it; override what the case needs. */
export function engineTask(
  overrides: Partial<EngineNode> & Pick<EngineNode, 'status'>,
): EngineNode {
  return engineNode({ lifecycle: 'todo', parent: 'MMR-1', type: 'task', ...overrides });
}

/** A task list holding `items` whole, as `list` returns one; `total` can claim more. */
export function taskSet(items: EngineNode[], total = items.length): TaskSet {
  return { items, returned: items.length, startsAt: 0, total };
}

/** The record-health facet: a clean whole-store scan unless the case says otherwise. */
export function recordHealth(overrides: Partial<RecordHealth> = {}): RecordHealth {
  return {
    finding_total: 0,
    groups: [],
    scanned_at: FIXTURE_AT.toISOString(),
    scope: null,
    ...overrides,
  };
}
