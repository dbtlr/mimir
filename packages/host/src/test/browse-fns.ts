// Shared test seam module, not a test body.
// oxlint-disable vitest/require-hook
import { MimirError } from '@mimir/contract';
import type { EngineNode } from '@mimir/contract';

import type { ArtifactRecord, ArtifactSummary, EngineSeed } from '../api/browse-queries';
import {
  artifacts,
  consoleOpenTasks,
  consoleUpstreamTasks,
  doctor,
  getArtifact,
  getSeed,
  list,
  seedCreate,
  seedPark,
  seedPromote,
  seedReject,
  seedResolve,
  seeds,
  seedUnpark,
  seedUpdate,
} from '../api/fns/browse';
import type { RecordHealth } from '../api/fns/browse';
import { engineSeed, recordHealth, taskSet } from './browse-fixtures';

/*
 * The browsers' server functions served from a small world (MMR-540). A test
 * file that renders a browser, a seed or artifact page, a seed write, or record
 * health mocks the module first — `vi.mock('../api/fns/browse')` at the top of
 * the file — and then calls `serveBrowse`, which answers each function from the
 * world it is given. A case that needs one answer of its own overrides that
 * function after, with `vi.mocked(fn).mockResolvedValueOnce(...)`, and asserts
 * the call by function: `expect(list).toHaveBeenCalledWith({ data: {...} })`.
 * See setup.ts for the pattern.
 */

export type BrowseWorld = {
  /** What every task list answers, the dependency picker's open tasks included. */
  tasks: EngineNode[];
  /** The artifact browser's rows, newest first; each page is a window of them. */
  artifacts: ArtifactSummary[];
  /** Artifact pages by id; an id without one is not found. */
  records: Record<string, ArtifactRecord>;
  /** Every seed on every board; a seed list answers its project's. */
  seeds: EngineSeed[];
  /** The tasks naming each seed as their upstream. */
  upstream: Record<string, EngineNode[]>;
  /** What record health answers. */
  health: RecordHealth;
};

const notFound = (id: string) => new MimirError('not_found', `${id} doesn't exist`);

/** Answer the browsers' server functions from `world`; the returned state is live. */
export function serveBrowse(world: Partial<BrowseWorld> = {}): BrowseWorld {
  const state: BrowseWorld = {
    artifacts: [],
    health: recordHealth(),
    records: {},
    seeds: [],
    tasks: [],
    upstream: {},
    ...world,
  };
  const seedOf = (id: string): EngineSeed =>
    state.seeds.find((s) => s.id === id) ?? engineSeed({ id });
  vi.mocked(list).mockImplementation(async () => taskSet(state.tasks));
  vi.mocked(consoleOpenTasks).mockImplementation(async () => taskSet(state.tasks));
  vi.mocked(artifacts).mockImplementation(async ({ data }) => {
    const offset = data.offset ?? 0;
    const items = state.artifacts.slice(offset, offset + (data.limit ?? state.artifacts.length));
    return { items, returned: items.length, startsAt: offset, total: state.artifacts.length };
  });
  vi.mocked(getArtifact).mockImplementation(async ({ data }) => {
    const found = state.records[data.id];
    if (found === undefined) {
      throw notFound(data.id);
    }
    return found;
  });
  vi.mocked(seeds).mockImplementation(async ({ data }) =>
    state.seeds.filter((s) => s.project === data.project),
  );
  vi.mocked(getSeed).mockImplementation(async ({ data }) => {
    const found = state.seeds.find((s) => s.id === data.id);
    if (found === undefined) {
      throw notFound(data.id);
    }
    return found;
  });
  vi.mocked(consoleUpstreamTasks).mockImplementation(async ({ data }) =>
    taskSet(state.upstream[data.seed] ?? []),
  );
  vi.mocked(doctor).mockImplementation(async () => state.health);
  vi.mocked(seedCreate).mockImplementation(async ({ data }) =>
    engineSeed({ kind: data.kind, project: data.project, title: data.title }),
  );
  vi.mocked(seedUpdate).mockImplementation(async ({ data }) => seedOf(data.id));
  vi.mocked(seedPark).mockImplementation(async ({ data }) => seedOf(data.id));
  vi.mocked(seedUnpark).mockImplementation(async ({ data }) => seedOf(data.id));
  vi.mocked(seedReject).mockImplementation(async ({ data }) => seedOf(data.id));
  vi.mocked(seedResolve).mockImplementation(async ({ data }) => seedOf(data.id));
  vi.mocked(seedPromote).mockImplementation(async ({ data }) => ({
    created: 'MMR-900',
    seed: seedOf(data.id),
    spawnedId: 'MMR-900',
  }));
  return state;
}

/** Every browser read fails, as when the host cannot be reached. */
export function failBrowseReads(error: Error = new Error('unreachable')): void {
  for (const read of [
    list,
    consoleOpenTasks,
    artifacts,
    getArtifact,
    seeds,
    getSeed,
    consoleUpstreamTasks,
  ]) {
    vi.mocked(read).mockRejectedValue(error);
  }
  vi.mocked(doctor).mockRejectedValue(error);
}
