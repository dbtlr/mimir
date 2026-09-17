import type { HistoryEntry } from '@mimir/contract';
import type { Kysely, Transaction } from 'kysely';

import { notFound, projectNotFound, validation } from '../errors';
import type { ExportedSeed } from '../export';
import { renderSeedRef } from '../ids';
import type { SeedRecord, SeedStore } from '../seeds/store';
import { assertLiveSeed, canTransitionSeed } from '../seeds/store';
import { now } from '../time';
import { insertBatched } from './batch';
import type { DB, SeedRow } from './schema';
import type { Executor } from './tx';
import { serializable } from './tx';

/**
 * The Postgres `SeedStore` (MMR-244) — a seed is one row keyed by its `KEY-sN`
 * stem, its `## Seed Description` prose a column and its `## History` an
 * append-only child table.
 *
 * The lifecycle machine and the terminal freeze live here, exactly as they do
 * on the Norn backend: the seam owns them, not the verbs. What a markdown
 * backend has to achieve with one atomic apply plan — the lifecycle field and
 * its history record can never diverge — this achieves with the transaction it
 * already runs in.
 */

const stemOf = (key: string, seq: number): string => renderSeedRef({ key, seq });

/**
 * Normalize description prose to the READ-BACK semantics: a create echo must
 * equal what a subsequent load returns, and the Norn read runs the prose
 * through the section parser (trim; blank reads as none). Storing the
 * normalized form is what makes the two backends answer identically.
 */
function normalizeDescription(description: string | null | undefined): string | null {
  const trimmed = (description ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function toRecord(row: SeedRow): SeedRecord {
  return {
    created_at: row.created_at,
    key: row.project_key,
    kind: row.kind,
    lifecycle: row.lifecycle,
    requester: row.requester,
    seq: row.seq,
    spawned: row.spawned,
    title: row.title,
    updated_at: row.updated_at,
  };
}

/** One seed's `## History`, in insertion order. */
async function historyOf(ex: Executor, id: string): Promise<HistoryEntry[]> {
  const rows = await ex
    .selectFrom('seed_history')
    .selectAll()
    .where('seed_id', '=', id)
    .orderBy('id')
    .execute();
  return rows.map((row) => ({
    at: row.at,
    from: row.from_value,
    kind: row.kind,
    reason: row.reason,
    to: row.to_value,
  }));
}

/** Append one lifecycle record to a seed's log. */
async function appendHistory(
  tx: Transaction<DB>,
  id: string,
  entry: { from: string; to: string; reason: string; at: string },
): Promise<void> {
  await tx
    .insertInto('seed_history')
    .values({
      at: entry.at,
      from_value: entry.from,
      kind: 'lifecycle',
      reason: entry.reason,
      seed_id: id,
      to_value: entry.to,
    })
    .execute();
}

/** Every seed with its description prose and its own history — the export's collection. */
export async function exportSeeds(ex: Executor): Promise<ExportedSeed[]> {
  const rows = await ex
    .selectFrom('seed')
    .selectAll()
    .orderBy('project_key')
    .orderBy('seq')
    .execute();
  const exported: ExportedSeed[] = [];
  for (const row of rows) {
    exported.push({
      ...toRecord(row),
      description: row.description,
      history: await historyOf(ex, row.id),
    });
  }
  return exported;
}

/**
 * Write whole seeds at their EXISTING identities — the import's writer.
 *
 * Plural because the import brings the whole collection at once: two batched
 * statements per chunk (the rows, then every seed's `## History` together)
 * rather than one round trip per seed and one per history entry.
 *
 * The history rows are written in document order across the whole batch, which
 * is the order `historyOf` reads them back in — `seed_history` has no ordering
 * column but its own insertion id.
 */
export async function insertExportedSeeds(
  tx: Transaction<DB>,
  seeds: readonly ExportedSeed[],
): Promise<void> {
  const rows = seeds.map((seed) => ({
    created_at: seed.created_at,
    description: seed.description,
    id: stemOf(seed.key, seed.seq),
    kind: seed.kind,
    lifecycle: seed.lifecycle,
    project_key: seed.key,
    requester: seed.requester,
    seq: seed.seq,
    spawned: seed.spawned,
    title: seed.title,
    updated_at: seed.updated_at,
  }));
  await insertBatched(rows, (chunk) => tx.insertInto('seed').values(chunk).execute());

  const history = seeds.flatMap((seed) =>
    seed.history.map((entry) => ({
      at: entry.at,
      from_value: entry.from,
      kind: entry.kind,
      reason: entry.reason,
      seed_id: stemOf(seed.key, seed.seq),
      to_value: entry.to,
    })),
  );
  await insertBatched(history, (chunk) => tx.insertInto('seed_history').values(chunk).execute());
}

export function createPostgresSeedStore(db: Kysely<DB>): SeedStore {
  const rowOf = async (ex: Executor, key: string, seq: number): Promise<SeedRow | undefined> =>
    ex.selectFrom('seed').selectAll().where('id', '=', stemOf(key, seq)).executeTakeFirst();

  /** The row a mutation targets, or the canonical absent-seed refusal. */
  const mutableRow = async (tx: Transaction<DB>, key: string, seq: number): Promise<SeedRow> => {
    const row = await rowOf(tx, key, seq);
    if (row === undefined) {
      throw notFound(`${stemOf(key, seq)} doesn't exist`);
    }
    return row;
  };

  return {
    async create(input) {
      return serializable(db, async (tx) => {
        const allocated = await tx
          .updateTable('project')
          .set((eb) => ({ last_seed_seq: eb('last_seed_seq', '+', 1) }))
          .where('key', '=', input.key)
          .returning('last_seed_seq')
          .executeTakeFirst();
        if (allocated === undefined) {
          throw projectNotFound(input.key);
        }
        const seq = allocated.last_seed_seq;
        const timestamp = now();
        const description = normalizeDescription(input.description);
        await tx
          .insertInto('seed')
          .values({
            created_at: timestamp,
            description,
            id: stemOf(input.key, seq),
            kind: input.kind,
            lifecycle: 'new',
            project_key: input.key,
            requester: input.requester,
            seq,
            spawned: [],
            title: input.title,
            updated_at: timestamp,
          })
          .execute();
        // Echoed IN FULL from what was just written: a fresh seed is `new` with
        // nothing spawned, so the verb renders this without a read-back.
        return {
          created_at: timestamp,
          description,
          key: input.key,
          kind: input.kind,
          lifecycle: 'new',
          requester: input.requester,
          seq,
          spawned: [],
          title: input.title,
          updated_at: timestamp,
        };
      });
    },

    async germinate(key, seq, nodeStem) {
      await serializable(db, async (tx) => {
        const row = await mutableRow(tx, key, seq);
        assertLiveSeed(row.id, row.lifecycle, 'promote applies only to a new or promoted seed');
        const alreadyLinked = row.spawned.includes(nodeStem);
        const needsPromote = row.lifecycle === 'new';
        // Idempotent: the stem is already linked AND the seed is already
        // promoted, so a retried promote cannot double-record.
        if (alreadyLinked && !needsPromote) {
          return;
        }
        const at = now();
        await tx
          .updateTable('seed')
          .set({
            ...(alreadyLinked ? {} : { spawned: [...row.spawned, nodeStem] }),
            ...(needsPromote ? { lifecycle: 'promoted' as const } : {}),
            updated_at: at,
          })
          .where('id', '=', row.id)
          .execute();
        if (needsPromote) {
          await appendHistory(tx, row.id, {
            at,
            from: row.lifecycle,
            reason: `promoted — spawned ${nodeStem}`,
            to: 'promoted',
          });
        }
      });
    },

    async listAll() {
      const rows = await db
        .selectFrom('seed')
        .selectAll()
        .orderBy('project_key')
        .orderBy('seq')
        .execute();
      return rows.map(toRecord);
    },

    async listForProject(key) {
      const rows = await db
        .selectFrom('seed')
        .selectAll()
        .where('project_key', '=', key)
        .orderBy('seq')
        .execute();
      return rows.map(toRecord);
    },

    async load(key, seq, opts) {
      const row = await rowOf(db, key, seq);
      if (row === undefined) {
        return undefined;
      }
      return opts?.content === true
        ? { ...toRecord(row), description: row.description }
        : toRecord(row);
    },

    async loadDescriptions(refs) {
      const out = new Map<string, string | null>();
      if (refs.length === 0) {
        return out;
      }
      const stems = [...new Set(refs.map(({ key, seq }) => stemOf(key, seq)))];
      const rows = await db
        .selectFrom('seed')
        .select(['id', 'description'])
        .where('id', 'in', stems)
        .execute();
      for (const row of rows) {
        out.set(row.id, row.description);
      }
      return out;
    },

    async loadHistory(key, seq) {
      const row = await rowOf(db, key, seq);
      // `undefined` when the seed is absent, `[]` when its history is empty —
      // the distinction the triage pass reads a terminal resolution from.
      return row === undefined ? undefined : historyOf(db, row.id);
    },

    async patch(key, seq, patch) {
      await serializable(db, async (tx) => {
        const row = await mutableRow(tx, key, seq);
        assertLiveSeed(
          row.id,
          row.lifecycle,
          'patches (title/kind/description) apply only to a new or promoted seed',
        );
        const changes = {
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.kind === undefined ? {} : { kind: patch.kind }),
          ...(patch.description === undefined
            ? {}
            : { description: normalizeDescription(patch.description) }),
        };
        // An empty patch writes nothing — no columns, no stamp.
        if (Object.keys(changes).length === 0) {
          return;
        }
        await tx
          .updateTable('seed')
          .set({ ...changes, updated_at: now() })
          .where('id', '=', row.id)
          .execute();
      });
    },

    async transition(key, seq, to, reason) {
      await serializable(db, async (tx) => {
        const row = await mutableRow(tx, key, seq);
        if (!canTransitionSeed(row.lifecycle, to)) {
          throw validation(
            `a seed cannot move ${row.lifecycle} → ${to}`,
            'legal edges: new → promoted | resolved | rejected; promoted → resolved | rejected',
          );
        }
        const at = now();
        await tx
          .updateTable('seed')
          .set({ lifecycle: to, updated_at: at })
          .where('id', '=', row.id)
          .execute();
        await appendHistory(tx, row.id, { at, from: row.lifecycle, reason, to });
      });
    },
  };
}
