import type { DeliveryHistory } from '@mimir/contract';
import type { Kysely, Transaction } from 'kysely';

import type { DeliveryStore, StoredDelivery } from '../deliveries/store';
import { assertLiveDelivery } from '../deliveries/store';
import { notFound, projectNotFound } from '../errors';
import type { StoreExport } from '../export';
import { renderDeliveryRef } from '../ids';
import { now } from '../time';
import { inLists } from './batch';
import type { StoreDialect } from './dialect';
import type { DB, DeliveryRow, Executor } from './schema';

/**
 * The SQL store's `DeliveryStore` (MMR-676): a delivery is one row keyed by its
 * `KEY-dN` stem, and its history an append-only child table read back in
 * insertion order. Storage only: the verbs in `../deliveries/intent` hold the
 * rules, and the terminal freeze is asserted inside the write it guards.
 */

const stemOf = (key: string, seq: number): string => renderDeliveryRef({ key, seq });

/** A row as the seam returns it, its columns in table order (the order every echo prints). */
function toStored(row: DeliveryRow, history: DeliveryHistory[]): StoredDelivery {
  const { id: _id, project_key: key, ...fields } = row;
  return { ...fields, history, key };
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
  return rows.map((row) => toStored(row, histories.get(row.id) ?? []));
}

async function appendHistory(
  tx: Transaction<DB>,
  id: string,
  history: readonly DeliveryHistory[],
): Promise<void> {
  // One row at a time, in order: the log's order is its insertion id.
  for (const entry of history) {
    await tx
      .insertInto('delivery_history')
      .values({ ...entry, delivery_id: id })
      .execute();
  }
}

export function createSqlDeliveryStore(db: Kysely<DB>, dialect: StoreDialect): DeliveryStore {
  return {
    create(input) {
      return dialect.write(db, async (tx) => {
        const allocated = await tx
          .updateTable('project')
          .set((eb) => ({ last_delivery_seq: eb('last_delivery_seq', '+', 1) }))
          .where('key', '=', input.key)
          .returning('last_delivery_seq')
          .executeTakeFirst();
        if (allocated === undefined) {
          throw projectNotFound(input.key);
        }
        const seq = allocated.last_delivery_seq;
        const at = now();
        const { key, ...terms } = input;
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
        // Read back so the echo carries the columns in table order, as every read does.
        const row = await tx
          .selectFrom('delivery')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        return toStored(row, []);
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
        await appendHistory(tx, id, history);
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
    await appendHistory(tx, row.id, history);
  }
}
