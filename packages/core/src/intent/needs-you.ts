import type { DecisionView, WorkNeedsYouRow } from '@mimir/contract';

import type { DerivationSet } from '../derive';
import type { Store } from '../store';

/** A decision puts work at risk if any linked task has not been abandoned. */
export const workBuiltOnIt = (set: DerivationSet, decision: DecisionView): boolean =>
  decision.tasks.some((id) => {
    const task = set.nodeById.get(id);
    return task !== undefined && task.lifecycle !== 'abandoned';
  });

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

/** Two cross-project reads per report; scope filtering uses the same work snapshot. */
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
  const inPhase = (phase: string) => scope === undefined || scope.all || scope.phases.has(phase);
  const rows: WorkNeedsYouRow[] = deliveries
    .filter((d) => (scope === undefined || d.key === scope.project) && inPhase(d.phase))
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
