import type { DeliveryFindingRecord, DeliveryHistory } from '@mimir/contract';
import type { Kysely, Transaction } from 'kysely';

import { assertBoardActive } from '../archive-lock';
import { ENDED_TASK_LIFECYCLES, joinable, joinDelivery } from '../deliveries/membership';
import { assertLiveDelivery, isTerminalDelivery } from '../deliveries/store';
import type { DeliveryStore, StoredDelivery } from '../deliveries/store';
import { notFound, validation } from '../errors';
import type { StoreExport } from '../export';
import { renderDeliveryRef } from '../ids';
import { now } from '../time';
import { inLists, insertBatched } from './batch';
import { visibleFollowUps, writeFollowUps } from './delivery-follow-ups';
import { appendDeliveryHistory } from './delivery-history';
import { readSinceSources } from './delivery-since';
import type { StoreDialect } from './dialect';
import type { DB, DeliveryRow, Executor } from './schema';
import { createSqlWriter } from './writer';

/**
 * The SQL store's `DeliveryStore` (MMR-676): a delivery is one row keyed by its
 * `KEY-dN` stem, and its history an append-only child table read back in
 * insertion order. Storage only: the verbs in `../deliveries/intent` hold the
 * rules, and the terminal freeze is asserted inside the write it guards.
 */

const stemOf = (key: string, seq: number): string => renderDeliveryRef({ key, seq });

/** A row as the seam returns it, its columns in table order (the order every echo prints). */
function toStored(
  row: DeliveryRow,
  history: DeliveryHistory[],
  members: string[] = [],
): StoredDelivery {
  const { id: _id, project_key: key, ...fields } = row;
  return { ...fields, history, key, members };
}

/** The history of each named delivery, in log order, keyed by its stem. */
async function historiesOf(
  ex: Executor,
  dialect: StoreDialect,
  ids: readonly string[],
): Promise<Map<string, DeliveryHistory[]>> {
  const out = new Map<string, DeliveryHistory[]>(ids.map((id) => [id, []]));
  for (const chunk of inLists(ids, dialect.maxParameters)) {
    const rows = await ex
      .selectFrom('delivery_history')
      .selectAll()
      .where('delivery_id', 'in', chunk)
      .orderBy('id')
      .execute();
    for (const { id: _id, delivery_id: delivery, ...entry } of rows) {
      out.get(delivery)?.push(entry);
    }
  }
  return out;
}

/**
 * The members of each named delivery, in task sequence order. The caller names
 * only non-terminal deliveries, since a terminal one has no members; of the
 * tasks naming one, the live ones are its members (ADR 0042).
 */
async function membersOf(
  ex: Executor,
  dialect: StoreDialect,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const chunk of inLists(ids, dialect.maxParameters)) {
    const rows = await ex
      .selectFrom('node')
      .select(['id', 'delivery'])
      .where('delivery', 'in', chunk)
      .where('lifecycle', 'not in', ENDED_TASK_LIFECYCLES)
      .orderBy('seq')
      .execute();
    for (const row of rows) {
      if (row.delivery !== null) {
        out.get(row.delivery)?.push(row.id);
      }
    }
  }
  return out;
}

async function storedOf(
  ex: Executor,
  dialect: StoreDialect,
  rows: readonly DeliveryRow[],
): Promise<StoredDelivery[]> {
  if (rows.length === 0) {
    return [];
  }
  const histories = await historiesOf(
    ex,
    dialect,
    rows.map((row) => row.id),
  );
  const members = await membersOf(
    ex,
    dialect,
    rows.filter((row) => !isTerminalDelivery(row.lifecycle)).map((row) => row.id),
  );
  return rows.map((row) => toStored(row, histories.get(row.id) ?? [], members.get(row.id) ?? []));
}

/** The largest seq both stores can hold: the columns and the transfer schema are int32. */
const MAX_DELIVERY_SEQ = 2_147_483_647;

/**
 * Hold the board's archive lock inside the write it guards. The verbs check it
 * first for their error; this read sits in the same transaction as the write, so
 * an archive that commits between that check and the write cannot be overwritten.
 */
async function lockActiveBoard(tx: Transaction<DB>, key: string): Promise<number> {
  const project = await tx
    .selectFrom('project')
    .select(['archived_at', 'last_delivery_seq'])
    .where('key', '=', key)
    .executeTakeFirst();
  assertBoardActive(project, key);
  return project?.last_delivery_seq ?? 0;
}

/** A delivery's entries in number order. */
async function loadFindings(ex: Executor, id: string): Promise<DeliveryFindingRecord[]> {
  return ex
    .selectFrom('delivery_finding')
    .select(['delivery_id as delivery', 'number', 'kind', 'text', 'reason', 'created_at'])
    .where('delivery_id', '=', id)
    .orderBy('number')
    .execute();
}

export function createSqlDeliveryStore(db: Kysely<DB>, dialect: StoreDialect): DeliveryStore {
  return {
    async appendFinding(key, seq, entry) {
      await dialect.write(db, async (tx) => {
        await lockActiveBoard(tx, key);
        const id = stemOf(key, seq);
        // The stamp comes first: it takes the delivery's row, so concurrent
        // appends queue here and each reads the number the last one wrote.
        const stamped = await tx
          .updateTable('delivery')
          .set({ updated_at: now() })
          .where('id', '=', id)
          .executeTakeFirst();
        if (Number(stamped.numUpdatedRows) === 0) {
          throw notFound(`${id} doesn't exist`);
        }
        const highest = await tx
          .selectFrom('delivery_finding')
          .select((eb) => eb.fn.max<number | null>('number').as('highest'))
          .where('delivery_id', '=', id)
          .executeTakeFirst();
        const number = (highest?.highest ?? 0) + 1;
        if (number > MAX_DELIVERY_SEQ) {
          throw validation(`${id} has used every entry number it can hold`);
        }
        await tx
          .insertInto('delivery_finding')
          .values({ ...entry, created_at: now(), delivery_id: id, number })
          .execute();
      });
    },

    create(input) {
      return dialect.write(db, async (tx) => {
        const last = await lockActiveBoard(tx, input.key);
        if (last >= MAX_DELIVERY_SEQ) {
          throw validation(`project ${input.key} has used every delivery id it can hold`);
        }
        const seq = last + 1;
        await tx
          .updateTable('project')
          .set({ last_delivery_seq: seq })
          .where('key', '=', input.key)
          .execute();
        const at = now();
        const { key, tasks, ...terms } = input;
        const id = stemOf(key, seq);
        await tx
          .insertInto('delivery')
          .values({
            ...terms,
            created_at: at,
            hold: 'none',
            hold_reason: null,
            id,
            lifecycle: 'agreed',
            project_key: key,
            seq,
            updated_at: at,
          })
          .execute();
        // Membership rides the store writer, so the sweep and `update --delivery`
        // apply one join rule and log through one path, inside this transaction.
        const w = createSqlWriter(tx, dialect);
        const delivery = { id, phase: input.phase };
        for (const taskId of tasks === undefined
          ? await w.listChildren(input.phase)
          : [...new Set(tasks)]) {
          const task = await w.loadNode(taskId);
          if (task === undefined || task.parent_id !== input.phase) {
            throw validation(`${taskId} is not a task in the delivery phase`);
          }
          // The sweep takes what can join; a named task that cannot refuses the create.
          if (tasks !== undefined || (await joinable(w, task, input.phase))) {
            await joinDelivery(w, task, delivery);
          }
        }
        // Read back so the echo carries the columns in table order, as every read does.
        const row = await tx
          .selectFrom('delivery')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        return (await storedOf(tx, dialect, [row]))[0] ?? toStored(row, []);
      });
    },

    findings: (key, seq) => loadFindings(db, stemOf(key, seq)),

    followUps: async (key, seq) =>
      (await visibleFollowUps(db, stemOf(key, seq)))
        .filter((row) => row.unlinked_at === null)
        .map((row) => ({ id: row.record, linked_at: row.linked_at, seed: row.seed })),
    // A read is the row, its history, and its members: one snapshot, so a join
    // committing mid-read never shows a member without its history row.
    listForProject(key) {
      return dialect.snapshot(db, async (tx) => {
        const rows = await tx
          .selectFrom('delivery')
          .selectAll()
          .where('project_key', '=', key)
          .orderBy('seq')
          .execute();
        return storedOf(tx, dialect, rows);
      });
    },

    async listStopped() {
      const rows = await db
        .selectFrom('delivery')
        .innerJoin('project', 'project.key', 'delivery.project_key')
        .selectAll('delivery')
        .where('delivery.hold', '=', 'stopped')
        .where('delivery.lifecycle', 'not in', ['landed', 'abandoned'])
        .where('project.archived_at', 'is', null)
        .execute();
      return rows.map((row) => toStored(row, []));
    },
    load(key, seq) {
      return dialect.snapshot(db, async (tx) => {
        const row = await tx
          .selectFrom('delivery')
          .selectAll()
          .where('id', '=', stemOf(key, seq))
          .executeTakeFirst();
        return row === undefined ? undefined : (await storedOf(tx, dialect, [row]))[0];
      });
    },

    async patch(key, seq, patch, history = [], links = { follow: [], unfollow: [] }) {
      await dialect.write(db, async (tx) => {
        await lockActiveBoard(tx, key);
        const id = stemOf(key, seq);
        const hasLinks = links.follow.length + links.unfollow.length > 0;
        if (hasLinks || Object.keys(patch).length > 0 || history.length > 0) {
          await tx
            .updateTable('delivery')
            .set({ ...patch, updated_at: now() })
            .where('id', '=', id)
            .execute();
        }
        const row = await tx
          .selectFrom('delivery')
          .select('lifecycle')
          .where('id', '=', id)
          .executeTakeFirst();
        if (row === undefined) {
          throw notFound(`${id} doesn't exist`);
        }
        if (!hasLinks || Object.keys(patch).length > 0) {
          assertLiveDelivery(id, row.lifecycle);
        }
        if (Object.keys(patch).length === 0 && history.length === 0 && !hasLinks) {
          return;
        }
        await writeFollowUps(tx, id, key, links, now());
        await appendDeliveryHistory(tx, id, history);
      });
    },
    sinceSources: (key, seq) => readSinceSources(db, dialect, stemOf(key, seq)),

    transact(key, seq, apply) {
      return dialect.write(db, async (tx) => {
        await lockActiveBoard(tx, key);
        const id = stemOf(key, seq);
        const row = await tx
          .selectFrom('delivery')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirst();
        if (row === undefined) {
          throw notFound(`${id} doesn't exist`);
        }
        assertLiveDelivery(id, row.lifecycle);
        const stored = (await storedOf(tx, dialect, [row]))[0];
        if (stored === undefined) {
          throw notFound(`${id} doesn't exist`);
        }
        const { patch, history } = await apply(stored, createSqlWriter(tx, dialect));
        await tx
          .updateTable('delivery')
          .set({ ...patch, updated_at: now() })
          .where('id', '=', id)
          .execute();
        await appendDeliveryHistory(tx, id, history);
        const updated = await tx
          .selectFrom('delivery')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        const result = (await storedOf(tx, dialect, [updated]))[0];
        return result ?? toStored(updated, []);
      });
    },
  };
}

/** Stored facts only, with log order preserved for transfer. */
export async function exportDeliveries(
  ex: Executor,
  dialect: StoreDialect,
): Promise<StoreExport['deliveries']> {
  const rows = await ex
    .selectFrom('delivery')
    .selectAll()
    .orderBy('project_key')
    .orderBy('seq')
    .execute();
  const histories = await historiesOf(
    ex,
    dialect,
    rows.map((row) => row.id),
  );
  return rows.map((row) => Object.assign(row, { history: histories.get(row.id) ?? [] }));
}

/** Write imported deliveries at their existing identities, each history in document order. */
export async function insertExportedDeliveries(
  tx: Transaction<DB>,
  deliveries: StoreExport['deliveries'],
): Promise<void> {
  for (const { history, ...row } of deliveries) {
    await tx.insertInto('delivery').values(row).execute();
    await appendDeliveryHistory(tx, row.id, history);
  }
}

/** Every entry, in project-key, then delivery-sequence, then number order. */
export async function exportDeliveryFindings(ex: Executor): Promise<DeliveryFindingRecord[]> {
  return ex
    .selectFrom('delivery_finding')
    .innerJoin('delivery', 'delivery.id', 'delivery_finding.delivery_id')
    .select([
      'delivery_finding.delivery_id as delivery',
      'delivery_finding.number',
      'delivery_finding.kind',
      'delivery_finding.text',
      'delivery_finding.reason',
      'delivery_finding.created_at',
    ])
    .orderBy('delivery.project_key')
    .orderBy('delivery.seq')
    .orderBy('delivery_finding.number')
    .execute();
}

/** Write imported entries, one statement per chunk (MMR-380's batching rule). */
export async function insertExportedDeliveryFindings(
  ex: Executor,
  dialect: StoreDialect,
  entries: readonly DeliveryFindingRecord[],
): Promise<void> {
  const rows = entries.map(({ delivery, ...entry }) => ({ ...entry, delivery_id: delivery }));
  await insertBatched(rows, dialect.maxParameters, (chunk) =>
    ex.insertInto('delivery_finding').values(chunk).execute(),
  );
}
