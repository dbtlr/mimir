import type { DeliveryHistory } from '@mimir/contract';
import type { Kysely, Transaction } from 'kysely';

import { assertBoardActive } from '../archive-lock';
import { ENDED_TASK_LIFECYCLES, joinable, joinDelivery } from '../deliveries/membership';
import { assertLiveDelivery, isTerminalDelivery } from '../deliveries/store';
import type { DeliveryStore, StoredDelivery } from '../deliveries/store';
import { notFound, validation } from '../errors';
import type { StoreExport } from '../export';
import { renderDeliveryRef } from '../ids';
import { now } from '../time';
import { inLists } from './batch';
import { appendDeliveryHistory } from './delivery-history';
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

export function createSqlDeliveryStore(db: Kysely<DB>, dialect: StoreDialect): DeliveryStore {
  return {
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

    async listForProject(key) {
      const rows = await db
        .selectFrom('delivery')
        .selectAll()
        .where('project_key', '=', key)
        .orderBy('seq')
        .execute();
      return storedOf(db, dialect, rows);
    },

    async load(key, seq) {
      const row = await db
        .selectFrom('delivery')
        .selectAll()
        .where('id', '=', stemOf(key, seq))
        .executeTakeFirst();
      return row === undefined ? undefined : (await storedOf(db, dialect, [row]))[0];
    },

    async patch(key, seq, patch, history = []) {
      await dialect.write(db, async (tx) => {
        await lockActiveBoard(tx, key);
        const id = stemOf(key, seq);
        const row = await tx
          .selectFrom('delivery')
          .select('lifecycle')
          .where('id', '=', id)
          .executeTakeFirst();
        if (row === undefined) {
          throw notFound(`${id} doesn't exist`);
        }
        assertLiveDelivery(id, row.lifecycle);
        if (Object.keys(patch).length === 0 && history.length === 0) {
          return;
        }
        await tx
          .updateTable('delivery')
          .set({ ...patch, updated_at: now() })
          .where('id', '=', id)
          .execute();
        await appendDeliveryHistory(tx, id, history);
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
