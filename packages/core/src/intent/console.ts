import type {
  FacetName,
  NodeView,
  OverviewReport,
  ReviewReport,
  SetResult,
  WorkReport,
} from '@mimir/contract';

import { requireTimeZone } from '../dates';
import { deriveSet, findNodeInSet } from '../derive';
import type { DoctorFacet } from '../doctor/facet';
import { validation } from '../errors';
import { parseIdentity } from '../ids';
import type { Store } from '../store';
import { listNodes, overviewOf } from './queries';
import { reviewOf } from './review';
import { workPageOf } from './work';

/**
 * The console's composite views. The HTTP routes and the Engine's `console.*`
 * methods both assemble them here, so key checks, the required time zone, and
 * the review page's findings handling live once.
 */

/** Per-project `doctor` finding counts. Core never runs doctor; the host supplies this. */
export type FindingsProvider = () => Promise<ReadonlyMap<string, number>>;

/** A whole-store doctor scan as a findings provider; none when no doctor is wired. */
export function findingsProviderOf(
  doctor: ((scope: string | undefined) => Promise<DoctorFacet>) | undefined,
): FindingsProvider | undefined {
  if (doctor === undefined) {
    return undefined;
  }
  return async () => {
    const facet = await doctor(undefined);
    return new Map(facet.groups.map((group) => [group.project, group.finding_count]));
  };
}

/**
 * The work and review pages need the caller's IANA zone: it decides where the
 * shipped days begin, and there is no fallback zone (ADR 0029).
 */
export function requireWorkTimeZone(timeZone: string | undefined): string {
  const zone = requireTimeZone(timeZone);
  if (zone === undefined) {
    throw validation(
      'this report needs the caller timezone (tz)',
      'pass an IANA timezone (tz), e.g. America/New_York',
    );
  }
  return zone;
}

type PageOptions = { asOf?: string; timeZone?: string };

/** The work page for a whole project; a task or a non-project token is refused. */
export async function projectWorkOf(
  store: Store,
  key: string,
  opts: PageOptions,
): Promise<WorkReport> {
  if (parseIdentity(key)?.kind !== 'project') {
    const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), key);
    if (node?.type === 'task') {
      throw validation(`${key} is a task, not a project`, 'a task has no work page');
    }
    throw validation(`${key} is not a project key`, `use /api/nodes/${key}/work`);
  }
  return workPageOf(store, key, { asOf: opts.asOf, timeZone: requireWorkTimeZone(opts.timeZone) });
}

/** The work page for an initiative or phase subtree; a project key belongs to {@link projectWorkOf}. */
export async function nodeWorkOf(store: Store, id: string, opts: PageOptions): Promise<WorkReport> {
  if (parseIdentity(id)?.kind === 'project') {
    throw validation(`${id} is a project`, `use /api/projects/${id}/work`);
  }
  return workPageOf(store, id, { asOf: opts.asOf, timeZone: requireWorkTimeZone(opts.timeZone) });
}

/** The project overview; `overviewOf` already refuses an unknown or archived project. */
export async function projectOverviewOf(
  store: Store,
  key: string,
  opts: { asOf?: string } = {},
): Promise<OverviewReport> {
  if (parseIdentity(key)?.kind !== 'project') {
    throw validation(`${key} is not a project key`, 'nodes live at /api/nodes/:id');
  }
  return overviewOf(store, key, opts);
}

/**
 * The cross-project review page. The findings scan starts before the store
 * loads so the two overlap. A failed scan counts no findings rather than failing
 * the page: the decisions carry the page, and the doctor report carries the failure.
 */
export async function reviewPageOf(
  store: Store,
  findings: FindingsProvider | undefined,
  opts: PageOptions,
): Promise<ReviewReport> {
  const timeZone = requireWorkTimeZone(opts.timeZone);
  const counts = (async (): Promise<ReadonlyMap<string, number>> => {
    if (findings === undefined) {
      return new Map();
    }
    try {
      return await findings();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `⚠ review: doctor scan failed; the review page counts no findings — ${message}`,
      );
      return new Map();
    }
  })();
  return reviewOf(store, counts, { asOf: opts.asOf, timeZone });
}

/** The set-read projection `/api/nodes` serves, so the console's task sets read alike. */
const NODE_SET_FACETS: readonly FacetName[] = ['deps', 'tags', 'distribution', 'verdicts', 'home'];

/**
 * The tasks on any board that name `seed` as their upstream (MMR-451), live or
 * settled: the requesting boards' work that waits on the seed. A seed nothing
 * names, or an id that names no seed, has none.
 */
export async function upstreamTasksOf(store: Store, seed: string): Promise<SetResult<NodeView>> {
  return listNodes(store, {
    facets: NODE_SET_FACETS,
    filters: [{ field: 'upstream', op: 'eq', value: seed }],
    status: 'all',
  });
}

/**
 * The open tasks on any active board whose id or title holds `q` (MMR-78): the
 * dependency picker's candidates, as `/api/nodes?type=task&q=` answers them.
 * The filter runs before any window, so older open tasks are never crowded out
 * by newer records of other kinds.
 */
export async function openTasksOf(store: Store, q: string): Promise<SetResult<NodeView>> {
  return listNodes(store, {
    facets: NODE_SET_FACETS,
    filters: [{ field: 'type', op: 'in', value: 'task' }],
    q,
  });
}
