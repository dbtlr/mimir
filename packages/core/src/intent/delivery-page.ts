import {
  decodeChecklist,
  decodeDecision,
  decodeDelivery,
  intentViews,
  consoleIntentViews,
} from '@mimir/contract';

import { decisions } from '../decisions/intent';
import { getDelivery, listDeliveries } from '../deliveries';
import { deriveSet, findNodeInSet } from '../derive';
import type { DerivationSet } from '../derive';
import { notFound, validation } from '../errors';
import type { Store } from '../store';
import { now } from '../time';
import { byNeedsYouRowOrder, workBuiltOnIt } from './needs-you';
import { buildNodeView } from './view';
import { classifyWork, workRowSource, nowRowsOf } from './work';

/** Resolve every row against the page's one derivation snapshot. */
async function rowOf(store: Store, set: DerivationSet, id: string) {
  const node = findNodeInSet(set, id);
  if (!node || set.archivedProjects.has(node.project_id)) {
    throw notFound(`${id} doesn't exist`);
  }
  return intentViews.node.parse(
    await buildNodeView(store.bodySections, store.artifacts, set, node),
  );
}

/**
 * A delivery's member rows from the read's snapshot. The snapshot loads before
 * the delivery does, so a task that joined in between is left out until the
 * next read, as an archived follow-up is, rather than failing the whole read.
 */
function memberRows(store: Store, set: DerivationSet, members: readonly string[]) {
  return Promise.all(
    members
      .filter((member) => findNodeInSet(set, member) !== undefined)
      .map((member) => rowOf(store, set, member)),
  );
}

/** The journal's newest entries the dossier shows, newest first. */
export const RECENT_JOURNAL_ENTRIES = 5;

/** The newest journal entries, newest first (the pad stores them oldest first). */
export function recentJournal<T>(journal: readonly T[]): T[] {
  return journal.slice(-RECENT_JOURNAL_ENTRIES).toReversed();
}

/** A phase's live deliveries: every lifecycle but `landed` and `abandoned`. */
export function liveDeliveriesOf<T extends { phase: string; lifecycle: string }>(
  deliveries: readonly T[],
  phase: string,
): T[] {
  return deliveries.filter(
    (d) => d.phase === phase && d.lifecycle !== 'landed' && d.lifecycle !== 'abandoned',
  );
}

/** The read-only delivery dossier: one snapshot for member and follow-up status words. */
export async function deliveryPageOf(store: Store, id: string) {
  const set = deriveSet(await store.loadWorkingSet());
  const delivery = decodeDelivery(await getDelivery(store, id, set));
  const followUpTasks = delivery.follow_ups
    .map((row) => row.id)
    .filter((followUp) => findNodeInSet(set, followUp)?.type === 'task');
  const [phase, members, open, followUps, pad] = await Promise.all([
    rowOf(store, set, delivery.phase),
    memberRows(store, set, delivery.members),
    decisions(store, {
      delivery: delivery.id,
      project: delivery.project_key,
      status: 'provisional',
    }),
    // One read for every follow-up task's items, however many the delivery links.
    store.checklist.forTasks(followUpTasks).then((byTask) =>
      delivery.follow_ups.map((row) => ({
        id: row.id,
        items: decodeChecklist({ items: byTask.get(row.id) ?? [], task: row.id }).items,
        status: row.status,
        title: row.title,
      })),
    ),
    delivery.journal.scratchpad === null
      ? undefined
      : store.scratchpads.load(delivery.journal.scratchpad),
  ]);
  const memberNodes = [...set.nodeById.values()].filter((node) =>
    delivery.members.includes(node.id),
  );
  const buckets = classifyWork(set, memberNodes, { asOf: now(), shippedWindow: undefined });
  const nowRows = consoleIntentViews.work.shape.now.parse(
    await nowRowsOf(workRowSource(store, set, buckets), delivery.project_key),
  );
  return {
    decisions: open
      .map((decision) => ({
        decision,
        kind: 'decision' as const,
        workBuiltOnIt: workBuiltOnIt(set, decision),
      }))
      // The one decision order, shared with the needs-you set.
      .toSorted(byNeedsYouRowOrder)
      .map((row) => decodeDecision(row.decision)),
    delivery,
    followUps,
    journal: pad ? recentJournal(intentViews.scratchpad.parse(pad).journal) : [],
    members,
    now: nowRows.filter(
      (row) => row.task.status === 'in_progress' || row.task.status === 'under_review',
    ),
    phase,
  };
}

/** The phase's live attempts, with rows for the shared status distribution. */
export async function phaseDeliveriesOf(store: Store, id: string) {
  const set = deriveSet(await store.loadWorkingSet());
  const phase = await rowOf(store, set, id);
  if (phase.type !== 'phase') {
    throw validation(`${id} is not a phase`);
  }
  const deliveries = await listDeliveries(store, findNodeInSet(set, id)?.project_id ?? '');
  return Promise.all(
    liveDeliveriesOf(deliveries, id).map(async (delivery) => ({
      delivery: decodeDelivery(delivery),
      members: await memberRows(store, set, delivery.members),
    })),
  );
}
