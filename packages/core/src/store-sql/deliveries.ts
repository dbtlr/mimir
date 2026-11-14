import type { DeliveryView, EngineInput } from '@mimir/contract';
import type { Kysely } from 'kysely';

import type { DeliveryStore } from '../deliveries/store';
import { deriveSet, findNodeInSet, statusOf } from '../derive';
import { conflict, notFound, validation } from '../errors';
import { parseDeliveryRef, renderDeliveryRef } from '../ids';
import { now } from '../time';
import type { StoreDialect } from './dialect';
import type { DB, Executor } from './schema';
import { loadWorkingSet } from './working-set';

async function active(ex: Executor, key: string) {
  const project = await ex
    .selectFrom('project')
    .selectAll()
    .where('key', '=', key)
    .executeTakeFirst();
  if (project === undefined) {
    throw notFound(`${key} doesn't exist`);
  }
  if (project.archived_at !== null) {
    throw conflict(
      `project ${key} is archived — no changes are allowed`,
      `unarchive it first: mimir unarchive ${key}`,
    );
  }
}
async function read(ex: Executor, id: string): Promise<DeliveryView> {
  const row = await ex.selectFrom('delivery').selectAll().where('id', '=', id).executeTakeFirst();
  if (row === undefined) {
    throw notFound(`${id} doesn't exist`);
  }
  const history = (
    await ex
      .selectFrom('delivery_history')
      .selectAll()
      .where('delivery_id', '=', id)
      .orderBy('id')
      .execute()
  ).map(({ id: _id, delivery_id: _delivery, ...entry }) => entry);
  const started = history.find(
    (entry) => entry.kind === 'lifecycle' && entry.to_value === 'running',
  );
  return {
    ...row,
    elapsed_minutes:
      started === undefined
        ? null
        : Math.max(0, (Date.parse(now()) - Date.parse(started.at)) / 60000),
    history,
  };
}
export function createSqlDeliveryStore(db: Kysely<DB>, dialect: StoreDialect): DeliveryStore {
  return {
    create(input: EngineInput<'deliveryCreate'>) {
      return dialect.write(db, async (tx) => {
        await active(tx, input.project);
        if (!input.title.trim()) {
          throw validation('a delivery requires a title');
        }
        const phase = await tx
          .selectFrom('node')
          .selectAll()
          .where('id', '=', input.phase)
          .executeTakeFirst();
        if (phase === undefined || phase.type !== 'phase' || phase.project_key !== input.project) {
          throw validation('--phase must name a live phase in the same project');
        }
        const set = deriveSet(await loadWorkingSet(tx, dialect));
        const phaseNode = findNodeInSet(set, phase.id);
        if (
          phaseNode !== undefined &&
          ['done', 'abandoned'].includes(statusOf(set, phaseNode).status)
        ) {
          throw validation('--phase must name a live phase');
        }
        const allocated = await tx
          .updateTable('project')
          .set((eb) => ({ last_delivery_seq: eb('last_delivery_seq', '+', 1) }))
          .where('key', '=', input.project)
          .returning('last_delivery_seq')
          .executeTakeFirstOrThrow();
        const seq = allocated.last_delivery_seq;
        const id = renderDeliveryRef({ key: input.project, seq });
        const at = now();
        await tx
          .insertInto('delivery')
          .values({
            agreement: input.agreement ?? null,
            branch: input.branch ?? null,
            created_at: at,
            external_ref: input.external_ref ?? null,
            harness: input.harness ?? null,
            hold: 'none',
            hold_reason: null,
            host: input.host ?? null,
            id,
            lifecycle: 'agreed',
            phase: input.phase,
            project_key: input.project,
            seq,
            session: input.session ?? null,
            time_cap_minutes: input.time_cap_minutes ?? null,
            title: input.title,
            updated_at: at,
          })
          .execute();
        return read(tx, id);
      });
    },
    async get(id: string) {
      const row = await read(db, id);
      const project = await db
        .selectFrom('project')
        .select('archived_at')
        .where('key', '=', row.project_key)
        .executeTakeFirst();
      if (project?.archived_at !== null) {
        throw notFound(`${id} doesn't exist`);
      }
      return row;
    },
    async list(project: string) {
      const owner = await db
        .selectFrom('project')
        .selectAll()
        .where('key', '=', project)
        .executeTakeFirst();
      if (owner === undefined || owner.archived_at !== null) {
        return [];
      }
      const rows = await db
        .selectFrom('delivery')
        .select('id')
        .where('project_key', '=', project)
        .orderBy('seq')
        .execute();
      return Promise.all(rows.map((row) => read(db, row.id)));
    },
    update(input: EngineInput<'deliveryUpdate'>) {
      return dialect.write(db, async (tx) => {
        if (input.title !== undefined && !input.title.trim()) {
          throw validation('a delivery requires a title');
        }
        const ref = parseDeliveryRef(input.id);
        if (ref === null) {
          throw validation(`${input.id} is not a delivery`);
        }
        await active(tx, ref.key);
        const row = await read(tx, input.id);
        if (row.lifecycle === 'landed' || row.lifecycle === 'abandoned') {
          throw validation(`${input.id} is terminal and refuses every write`);
        }
        const { id, ...fields } = input;
        await tx
          .updateTable('delivery')
          .set({ ...fields, updated_at: now() })
          .where('id', '=', id)
          .execute();
        return read(tx, id);
      });
    },
  };
}

/** Stored facts only, with log order preserved for transfer. */
export async function exportDeliveries(ex: Executor) {
  const rows = await ex
    .selectFrom('delivery')
    .selectAll()
    .orderBy('project_key')
    .orderBy('seq')
    .execute();
  const result = [];
  for (const row of rows) {
    const view = await read(ex, row.id);
    const { elapsed_minutes: _elapsed, ...stored } = view;
    result.push(stored);
  }
  return result;
}
