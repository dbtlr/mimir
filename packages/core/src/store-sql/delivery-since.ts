import type { Kysely } from 'kysely';

import type { SinceSources } from '../deliveries/since';
import { inLists } from './batch';
import type { StoreDialect } from './dialect';
import type { DB, Executor } from './schema';
import { toRowId } from './schema';

/**
 * The raw rows of every source of one delivery's since read (ADR 0042,
 * MMR-692), read inside one snapshot by {@link readSinceSources}. This module
 * only reads: which rows are events, which spans they fall in, and their order
 * are the pure functions of `../deliveries/since`.
 */

/** The transition kinds a member task's feed reports; a member cannot be moved and archive rows are project rows. */
const TASK_TRANSITION_KINDS = ['lifecycle', 'hold', 'dependency', 'assignment'] as const;

/** Every task a `member` history row names: each was a member for at least one span. */
function everMembers(history: SinceSources['history']): string[] {
  return [
    ...new Set(
      history.flatMap((row) => (row.kind === 'member' && row.task !== null ? [row.task] : [])),
    ),
  ];
}

async function taskRows(
  ex: Executor,
  dialect: StoreDialect,
  tasks: readonly string[],
): Promise<Pick<SinceSources, 'items' | 'notes' | 'transitions'>> {
  const out: Pick<SinceSources, 'items' | 'notes' | 'transitions'> = {
    items: [],
    notes: [],
    transitions: [],
  };
  for (const chunk of inLists(tasks, dialect.maxParameters)) {
    for (const row of await ex
      .selectFrom('transition_log')
      .select(['id', 'node_id', 'kind', 'from_value', 'to_value', 'reason', 'at'])
      .where('node_id', 'in', chunk)
      .where('kind', 'in', TASK_TRANSITION_KINDS)
      .execute()) {
      if (row.node_id !== null && row.kind !== 'move' && row.kind !== 'archive') {
        out.transitions.push({ ...row, id: toRowId(row.id), kind: row.kind, node_id: row.node_id });
      }
    }
    for (const row of await ex
      .selectFrom('annotation')
      .select(['id', 'node_id', 'content', 'created_at'])
      .where('node_id', 'in', chunk)
      .execute()) {
      out.notes.push({
        at: row.created_at,
        id: toRowId(row.id),
        task: row.node_id,
        text: row.content,
      });
    }
    for (const row of await ex
      .selectFrom('checklist_item')
      .selectAll()
      .where('node_id', 'in', chunk)
      .execute()) {
      const { node_id: task, content, ...rest } = row;
      out.items.push({ ...rest, content, task });
    }
  }
  return out;
}

/** The decisions linked to `delivery` now, and the history rows the feed may use from any decision. */
async function decisionRows(
  ex: Executor,
  dialect: StoreDialect,
  delivery: string,
): Promise<Pick<SinceSources, 'decisionHistory' | 'decisions'>> {
  const decisions = await ex
    .selectFrom('decision')
    .select(['id', 'question', 'created_at'])
    .where('delivery', '=', delivery)
    .execute();
  const columns = [
    'id',
    'decision_id',
    'kind',
    'from_value',
    'to_value',
    'reason',
    'task',
    'at',
  ] as const;
  const naming = await ex
    .selectFrom('decision_history')
    .select(columns)
    .where('kind', '=', 'delivery')
    .where((eb) => eb.or([eb('from_value', '=', delivery), eb('to_value', '=', delivery)]))
    .execute();
  const own: typeof naming = [];
  for (const chunk of inLists(
    decisions.map((decision) => decision.id),
    dialect.maxParameters,
  )) {
    own.push(
      ...(await ex
        .selectFrom('decision_history')
        .select(columns)
        .where('decision_id', 'in', chunk)
        .execute()),
    );
  }
  // A moved decision's naming rows come once, even when it is also linked here again.
  const seen = new Set<string>();
  const decisionHistory: SinceSources['decisionHistory'] = [];
  for (const row of [...own, ...naming]) {
    const key = String(toRowId(row.id));
    if (!seen.has(key)) {
      seen.add(key);
      decisionHistory.push({
        at: row.at,
        decision: row.decision_id,
        from_value: row.from_value,
        id: toRowId(row.id),
        kind: row.kind,
        reason: row.reason,
        task: row.task,
        to_value: row.to_value,
      });
    }
  }
  return { decisionHistory, decisions };
}

/**
 * Read every source of `delivery`'s feed in one snapshot, so a write that
 * commits mid-read shows in every source or none. An absent delivery reads as
 * empty sources; the caller has already refused it.
 */
export function readSinceSources(
  db: Kysely<DB>,
  dialect: StoreDialect,
  delivery: string,
): Promise<SinceSources> {
  return dialect.snapshot(db, async (tx) => {
    const history: SinceSources['history'] = [];
    for (const row of await tx
      .selectFrom('delivery_history')
      .select(['id', 'at', 'kind', 'from_value', 'to_value', 'reason', 'task'])
      .where('delivery_id', '=', delivery)
      .execute()) {
      history.push({ ...row, id: toRowId(row.id) });
    }
    const findings = await tx
      .selectFrom('delivery_finding')
      .select(['delivery_id as delivery', 'number', 'kind', 'text', 'reason', 'created_at'])
      .where('delivery_id', '=', delivery)
      .execute();
    const journals = await tx
      .selectFrom('artifact')
      .select(['id', 'title', 'created_at'])
      .where('delivery', '=', delivery)
      .execute();
    return {
      ...(await taskRows(tx, dialect, everMembers(history))),
      ...(await decisionRows(tx, dialect, delivery)),
      delivery,
      findings,
      history,
      journals,
    };
  });
}
