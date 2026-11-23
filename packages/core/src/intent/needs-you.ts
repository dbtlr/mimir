import type { DecisionView, ReviewReport, WorkNeedsYouRow } from '@mimir/contract';

import type { StoredDelivery } from '../deliveries/store';
import type { DerivationSet } from '../derive';
import type { Store } from '../store';

/** Whether a task exists and has not been abandoned. */
function isLiveTask(set: DerivationSet, id: string): boolean {
  const task = set.nodeById.get(id);
  return task !== undefined && task.lifecycle !== 'abandoned';
}

/** A decision puts work at risk if any linked task has not been abandoned. */
export const workBuiltOnIt = (set: DerivationSet, decision: Pick<DecisionView, 'tasks'>): boolean =>
  decision.tasks.some((id) => isLiveTask(set, id));

export function needsYouId(row: WorkNeedsYouRow): string {
  switch (row.kind) {
    case 'task': {
      return row.task.id;
    }
    case 'decision': {
      return row.decision.id;
    }
    case 'delivery': {
      return row.delivery.id;
    }
    default: {
      const unexpected: never = row;
      return unexpected;
    }
  }
}
export function needsYouRank(row: WorkNeedsYouRow): number {
  switch (row.kind) {
    case 'delivery': {
      return 0;
    }
    case 'decision': {
      return row.workBuiltOnIt ? 1 : 4;
    }
    case 'task': {
      return row.reason === 'blocked' ? 2 : 3;
    }
    default: {
      const unexpected: never = row;
      return unexpected;
    }
  }
}
export function needsYouClock(row: WorkNeedsYouRow): string {
  switch (row.kind) {
    case 'task': {
      return row.task.updatedAt;
    }
    case 'decision': {
      return row.decision.created_at;
    }
    case 'delivery': {
      return row.delivery.updated_at;
    }
    default: {
      const unexpected: never = row;
      return unexpected;
    }
  }
}
function sequence(row: WorkNeedsYouRow): number {
  switch (row.kind) {
    case 'task': {
      return Number(row.task.id.split('-').at(-1));
    }
    case 'decision': {
      return row.decision.seq;
    }
    case 'delivery': {
      return row.delivery.seq;
    }
    default: {
      const unexpected: never = row;
      return unexpected;
    }
  }
}
export function needsYouProject(row: WorkNeedsYouRow): string {
  switch (row.kind) {
    case 'task': {
      return row.task.id.slice(0, row.task.id.lastIndexOf('-'));
    }
    case 'decision': {
      return row.decision.project_key;
    }
    case 'delivery': {
      return row.delivery.project;
    }
    default: {
      const unexpected: never = row;
      return unexpected;
    }
  }
}
function compare(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}
/** The five kinds, each by its own newest clock, lowest sequence, then project. */
export const byNeedsYouRowOrder = (a: WorkNeedsYouRow, b: WorkNeedsYouRow): number =>
  needsYouRank(a) - needsYouRank(b) ||
  compare(needsYouClock(b), needsYouClock(a)) ||
  sequence(a) - sequence(b) ||
  compare(needsYouProject(a), needsYouProject(b));

/** Join deck facts from the working set in the deck's queue order. */
export function needsYouFactsOf(
  set: DerivationSet,
  rows: readonly WorkNeedsYouRow[],
): ReviewReport['needsYouFacts'] {
  const deliveries = new Map<string, Pick<StoredDelivery, 'phase' | 'title'>>();
  type BundleSet = ReviewReport['needsYouFacts']['bundles'][number]['set'];
  const bundles = new Map<string, { set: BundleSet; tasks: Set<string> }>();
  for (const row of rows) {
    if (row.kind === 'delivery') {
      deliveries.set(row.delivery.id, row.delivery);
      continue;
    }
    if (row.kind !== 'decision') {
      continue;
    }
    const { delivery, project_key: project, tasks } = row.decision;
    if (delivery !== null && !deliveries.has(delivery)) {
      const record = set.ws.deliveries.get(delivery);
      if (record !== undefined) {
        deliveries.set(delivery, record);
      }
    }
    const key = delivery ?? project;
    let bundle = bundles.get(key);
    if (bundle === undefined) {
      bundle = {
        set:
          delivery === null
            ? { key: project, kind: 'project' }
            : { id: delivery, kind: 'delivery' },
        tasks: new Set(),
      };
      bundles.set(key, bundle);
    }
    for (const task of tasks) {
      if (isLiveTask(set, task)) {
        bundle.tasks.add(task);
      }
    }
  }
  return {
    bundles: Array.from(bundles.values(), (bundle) => ({ ...bundle, tasks: [...bundle.tasks] })),
    deliveries: Array.from(deliveries, ([id, { phase, title }]) => ({
      id,
      phase: { id: phase, title: set.nodeById.get(phase)?.title ?? null },
      title,
    })),
  };
}

/**
 * The stopped-delivery and provisional-decision rows: two cross-project store
 * reads per call, taken after the work snapshot. Only projects active in that
 * snapshot's `set` contribute, so these rows agree with the snapshot's task rows
 * even when a project is archived between the reads; `scope` narrows to one
 * project and, unless `all`, to the given phases and tasks.
 */
export async function recordNeedsYou(
  store: Store,
  set: DerivationSet,
  scope?: {
    project: string;
    phases: ReadonlySet<string>;
    tasks: ReadonlySet<string>;
    all: boolean;
  },
): Promise<WorkNeedsYouRow[]> {
  const [deliveries, decisions] = await Promise.all([
    store.deliveries.listStopped(),
    store.decisions.listProvisional(),
  ]);
  const active = (key: string) => set.projectByKey.get(key)?.archived_at === null;
  const inPhase = (phase: string) => scope === undefined || scope.all || scope.phases.has(phase);
  const rows: WorkNeedsYouRow[] = deliveries
    .filter(
      (d) => active(d.key) && (scope === undefined || d.key === scope.project) && inPhase(d.phase),
    )
    .map((d) => ({
      delivery: {
        hold_reason: d.hold_reason,
        id: `${d.key}-d${d.seq}`,
        lifecycle: d.lifecycle,
        phase: d.phase,
        project: d.key,
        seq: d.seq,
        title: d.title,
        updated_at: d.updated_at,
      },
      kind: 'delivery',
    }));
  for (const decision of decisions) {
    if (!active(decision.project_key)) {
      continue;
    }
    if (
      scope !== undefined &&
      (decision.project_key !== scope.project ||
        (!scope.all &&
          !decision.tasks.some((id) => scope.tasks.has(id)) &&
          !(
            decision.delivery &&
            scope.phases.has(set.ws.deliveries.get(decision.delivery)?.phase ?? '')
          )))
    ) {
      continue;
    }
    rows.push({ decision, kind: 'decision', workBuiltOnIt: workBuiltOnIt(set, decision) });
  }
  return rows;
}
