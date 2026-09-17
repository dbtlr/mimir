import type { Scratchpad } from '@mimir/contract';
import type { Insertable, Kysely, Transaction } from 'kysely';

import { conflict, validation } from '../errors';
import { lintScratchpadValue } from '../scratchpads/codec';
import type { ScratchpadStore } from '../scratchpads/store';
import type { DB, ScratchpadRow, ScratchpadTable } from './schema';
import type { Executor } from './tx';
import { serializable } from './tx';

/**
 * The Postgres `ScratchpadStore` — UUID-addressed, project-owned temporary
 * episode documents.
 *
 * The store stamps NOTHING here. A pad's `updatedAt` is both its value and its
 * optimistic-concurrency token, so the caller supplies every timestamp and the
 * store only checks that the one it is handed still matches what it holds.
 */

/** Newest first, ties broken by id — the one order every scratchpad list has. */
const LIST_ORDER = (a: Scratchpad, b: Scratchpad): number =>
  b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

function toScratchpad(row: ScratchpadRow): Scratchpad {
  return {
    agenda: row.agenda,
    anchors: row.anchors,
    createdAt: row.created_at,
    freezingAt: row.freezing_at,
    id: row.id,
    journal: row.journal,
    project: row.project_key,
    title: row.title,
    updatedAt: row.updated_at,
  };
}

/** The whole row one pad becomes — the single write shape create/replace share.
 * The two owned body sections ride `jsonb`, handed over as JSON text so the
 * driver never has to guess the parameter's type. */
function toRow(pad: Scratchpad): Insertable<ScratchpadTable> {
  return {
    agenda: JSON.stringify(pad.agenda),
    anchors: pad.anchors,
    created_at: pad.createdAt,
    freezing_at: pad.freezingAt,
    id: pad.id,
    journal: JSON.stringify(pad.journal),
    project_key: pad.project,
    title: pad.title,
    updated_at: pad.updatedAt,
  };
}

/** Every scratchpad, whole — the store export's collection. */
export async function exportScratchpads(ex: Executor): Promise<Scratchpad[]> {
  const rows = await ex.selectFrom('scratchpad').selectAll().execute();
  return rows.map(toScratchpad).toSorted(LIST_ORDER);
}

/** Write one whole scratchpad — shared by `create` and the store import. */
export async function insertScratchpad(tx: Transaction<DB>, pad: Scratchpad): Promise<void> {
  await tx.insertInto('scratchpad').values(toRow(pad)).execute();
}

/** One pad's row by its UUID handle, or undefined. */
async function rowOf(ex: Executor, id: string): Promise<ScratchpadRow | undefined> {
  return ex.selectFrom('scratchpad').selectAll().where('id', '=', id).executeTakeFirst();
}

export function createPostgresScratchpadStore(db: Kysely<DB>): ScratchpadStore {
  return {
    async create(pad) {
      if (lintScratchpadValue(pad).length > 0) {
        throw validation('the scratchpad Agenda state is not valid for persistence');
      }
      await serializable(db, async (tx) => {
        if ((await rowOf(tx, pad.id)) !== undefined) {
          throw conflict(`scratchpad ${pad.id} already exists`);
        }
        const project = await tx
          .selectFrom('project')
          .select('key')
          .where('key', '=', pad.project)
          .executeTakeFirst();
        if (project === undefined) {
          throw validation('the scratchpad is not valid for persistence');
        }
        await insertScratchpad(tx, pad);
      });
    },

    async delete(id, expectedUpdatedAt) {
      await serializable(db, async (tx) => {
        const row = await rowOf(tx, id);
        // An absent pad is already deleted — silence, not a refusal.
        if (row === undefined) {
          return;
        }
        if (row.updated_at !== expectedUpdatedAt) {
          throw validation(
            'the scratchpad changed concurrently',
            'reload it and retry the mutation',
          );
        }
        await tx.deleteFrom('scratchpad').where('id', '=', id).execute();
      });
    },

    async list(project) {
      const rows = await db
        .selectFrom('scratchpad')
        .selectAll()
        .$if(project !== undefined, (qb) => qb.where('project_key', '=', project ?? ''))
        .execute();
      return rows.map(toScratchpad).toSorted(LIST_ORDER);
    },

    async load(id) {
      const row = await rowOf(db, id);
      return row === undefined ? undefined : toScratchpad(row);
    },

    async replace(pad, expectedUpdatedAt) {
      await serializable(db, async (tx) => {
        const row = await rowOf(tx, pad.id);
        if (row === undefined) {
          throw validation(`${pad.id} does not name a readable scratchpad`);
        }
        if (row.updated_at !== expectedUpdatedAt) {
          throw validation(
            'the scratchpad changed concurrently',
            'reload it and retry the mutation',
          );
        }
        if (pad.updatedAt <= row.updated_at) {
          throw validation('the scratchpad updatedAt must advance on replacement');
        }
        if (lintScratchpadValue(pad).length > 0) {
          throw validation('the scratchpad Agenda state is not valid for persistence');
        }
        if (pad.project !== row.project_key || pad.createdAt !== row.created_at) {
          throw validation('scratchpad project and createdAt are immutable');
        }
        const next = toRow(pad);
        await tx
          .updateTable('scratchpad')
          .set({
            agenda: next.agenda,
            anchors: next.anchors,
            freezing_at: next.freezing_at,
            journal: next.journal,
            title: next.title,
            updated_at: next.updated_at,
          })
          .where('id', '=', pad.id)
          .execute();
      });
    },
  };
}
