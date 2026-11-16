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

/** The read-only delivery dossier: one snapshot for member and follow-up status words. */
export async function deliveryPageOf(store: Store, id: string) {
  const set = deriveSet(await store.loadWorkingSet());
  const delivery = decodeDelivery(await getDelivery(store, id, set));
  const [phase, members, open, followUps, pad] = await Promise.all([
    rowOf(store, set, delivery.phase),
    Promise.all(delivery.members.map((member) => rowOf(store, set, member))),
    decisions(store, {
      delivery: delivery.id,
      project: delivery.project_key,
      status: 'provisional',
    }),
    Promise.all(
      delivery.follow_ups.map(async (row) => ({
        id: row.id,
        items:
          findNodeInSet(set, row.id)?.type === 'task'
            ? decodeChecklist({ items: await store.checklist.forTask(row.id), task: row.id }).items
            : [],
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
    decisions: open.map(decodeDecision),
    delivery,
    followUps,
    journal: pad ? intentViews.scratchpad.parse(pad).journal.slice(-5).toReversed() : [],
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
  const deliveries = await listDeliveries(store, id.slice(0, id.indexOf('-')));
  return Promise.all(
    deliveries
      .filter((d) => d.phase === id && d.lifecycle !== 'landed' && d.lifecycle !== 'abandoned')
      .map(async (delivery) => ({
        delivery: decodeDelivery(delivery),
        members: await Promise.all(delivery.members.map((member) => rowOf(store, set, member))),
      })),
  );
}
