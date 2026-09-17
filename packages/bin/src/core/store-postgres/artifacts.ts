import type { Kysely, Transaction } from 'kysely';

import type { ArtifactListQuery, ArtifactRecord, ArtifactStore } from '../artifacts/store';
import { stripTrailingNewline } from '../content';
import { withinWindow } from '../dates';
import { invariant, projectNotFound } from '../errors';
import type { ExportedArtifact } from '../export';
import { renderArtifactRef } from '../ids';
import { now } from '../time';
import { insertBatched } from './batch';
import type { ArtifactRow, DB } from './schema';
import type { Executor } from './tx';
import { serializable } from './tx';

/**
 * The Postgres `ArtifactStore` (MMR-143, ADR 0016 Phase 2a). An artifact is one
 * row keyed by its `KEY-aN` stem, its tags in the shared tag table and its
 * links in `artifact_link`; the frozen content is a column.
 *
 * Content is stored WITHOUT its trailing newline — the form the seam hands back
 * — so a create echo, a load, and an export all yield the identical string, and
 * a round trip through the transfer document cannot shed a newline per hop.
 *
 * Allocation is the project's `last_artifact_seq` counter bumped inside the
 * write transaction (ADR 0006): one authority, no client-side `max(seq)+1`.
 */

const stemOf = (key: string, seq: number): string => renderArtifactRef({ key, seq });

/** The record shape the seam speaks, assembled from the row and its relations. */
function toRecord(row: ArtifactRow, tags: string[], links: string[]): ArtifactRecord {
  return {
    created_at: row.created_at,
    key: row.project_key,
    links,
    seq: row.seq,
    summary: row.summary,
    tags,
    title: row.title,
    updated_at: row.updated_at,
  };
}

/** Tag sets for many artifacts at once, keyed by stem and tag-sorted. */
async function tagsFor(ex: Executor, ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) {
    return out;
  }
  const rows = await ex
    .selectFrom('tag')
    .select(['entity_id', 'tag'])
    .where('entity_type', '=', 'artifact')
    .where('entity_id', 'in', [...ids])
    .orderBy('tag')
    .execute();
  for (const row of rows) {
    out.set(row.entity_id, [...(out.get(row.entity_id) ?? []), row.tag]);
  }
  return out;
}

/** Link sets for many artifacts at once, keyed by stem and stem-sorted. */
async function linksFor(ex: Executor, ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) {
    return out;
  }
  const rows = await ex
    .selectFrom('artifact_link')
    .select(['artifact_id', 'node_id'])
    .where('artifact_id', 'in', [...ids])
    .orderBy('node_id')
    .execute();
  for (const row of rows) {
    out.set(row.artifact_id, [...(out.get(row.artifact_id) ?? []), row.node_id]);
  }
  return out;
}

/** Decorate artifact rows with their tags and links in one pair of queries. */
async function decorate(ex: Executor, rows: readonly ArtifactRow[]): Promise<ArtifactRecord[]> {
  const ids = rows.map((row) => row.id);
  const tags = await tagsFor(ex, ids);
  const links = await linksFor(ex, ids);
  return rows.map((row) => toRecord(row, tags.get(row.id) ?? [], links.get(row.id) ?? []));
}

/**
 * Every artifact with its frozen content and `source_scratch` — the store
 * export's artifact collection, `(key, seq)` ordered.
 */
export async function exportArtifacts(ex: Executor): Promise<ExportedArtifact[]> {
  const rows = await ex
    .selectFrom('artifact')
    .selectAll()
    .orderBy('project_key')
    .orderBy('seq')
    .execute();
  const records = await decorate(ex, rows);
  const exported: ExportedArtifact[] = [];
  for (const [index, record] of records.entries()) {
    const row = rows[index];
    exported.push(
      Object.assign(record, {
        content: row?.content ?? '',
        source_scratch: row?.source_scratch ?? null,
      }),
    );
  }
  return exported;
}

/**
 * Write whole artifacts at their EXISTING identities — the import's writer.
 *
 * Plural because the import brings the whole collection at once: three batched
 * statements per chunk (rows, tags, links) rather than three per artifact.
 */
export async function insertExportedArtifacts(
  tx: Transaction<DB>,
  artifacts: readonly ExportedArtifact[],
): Promise<void> {
  const rows = artifacts.map((artifact) => ({
    content: artifact.content,
    created_at: artifact.created_at,
    id: stemOf(artifact.key, artifact.seq),
    project_key: artifact.key,
    seq: artifact.seq,
    source_scratch: artifact.source_scratch,
    summary: artifact.summary,
    title: artifact.title,
    updated_at: artifact.updated_at,
  }));
  await insertBatched(rows, (chunk) => tx.insertInto('artifact').values(chunk).execute());
  await writeRelations(
    tx,
    artifacts.map((artifact) => ({
      id: stemOf(artifact.key, artifact.seq),
      links: artifact.links,
      tags: artifact.tags,
    })),
  );
}

/** A pair-keyed dedupe key, unambiguous whatever the two values contain. */
function relationKey(id: string, value: string): string {
  return JSON.stringify([id, value]);
}

/** One artifact's relations as the writer takes them. */
type ArtifactRelations = {
  id: string;
  tags: readonly string[];
  links: readonly string[];
};

/**
 * The tag and link rows of any number of artifacts, deduped across the whole
 * batch. `ON CONFLICT DO NOTHING` would settle a repeat on its own; deduping
 * first keeps a repeated tag from spending bind parameters, which are the
 * budget the batch is chunked against (see ./batch).
 */
async function writeRelations(
  tx: Transaction<DB>,
  artifacts: readonly ArtifactRelations[],
): Promise<void> {
  const tags = new Map<string, { entity_id: string; entity_type: 'artifact'; tag: string }>();
  const links = new Map<string, { artifact_id: string; node_id: string }>();
  for (const artifact of artifacts) {
    for (const tag of artifact.tags) {
      tags.set(relationKey(artifact.id, tag), {
        entity_id: artifact.id,
        entity_type: 'artifact',
        tag,
      });
    }
    for (const node_id of artifact.links) {
      links.set(relationKey(artifact.id, node_id), { artifact_id: artifact.id, node_id });
    }
  }
  await insertBatched([...tags.values()], (chunk) =>
    tx
      .insertInto('tag')
      .values(chunk)
      .onConflict((oc) => oc.doNothing())
      .execute(),
  );
  await insertBatched([...links.values()], (chunk) =>
    tx
      .insertInto('artifact_link')
      .values(chunk)
      .onConflict((oc) => oc.doNothing())
      .execute(),
  );
}

export function createPostgresArtifactStore(db: Kysely<DB>): ArtifactStore {
  /** One artifact row by its canonical identity, or undefined. */
  const rowOf = async (ex: Executor, key: string, seq: number): Promise<ArtifactRow | undefined> =>
    ex.selectFrom('artifact').selectAll().where('id', '=', stemOf(key, seq)).executeTakeFirst();

  return {
    async applyTag(key, seq, tag) {
      await serializable(db, async (tx) => {
        const row = await rowOf(tx, key, seq);
        if (row === undefined) {
          return;
        }
        const applied = await tx
          .insertInto('tag')
          .values({ entity_id: row.id, entity_type: 'artifact', tag })
          .onConflict((oc) => oc.doNothing())
          .executeTakeFirst();
        // A no-op re-tag writes nothing — no row, no stamp (MMR-303 posture).
        if ((applied.numInsertedOrUpdatedRows ?? 0n) === 0n) {
          return;
        }
        await tx
          .updateTable('artifact')
          .set({ updated_at: now() })
          .where('id', '=', row.id)
          .execute();
      });
    },

    async create(input) {
      return serializable(db, async (tx) => {
        // The counter bump IS the allocation (ADR 0006): one atomic UPDATE …
        // RETURNING inside the write transaction, so two concurrent creates
        // cannot be handed the same sequence.
        const allocated = await tx
          .updateTable('project')
          .set((eb) => ({ last_artifact_seq: eb('last_artifact_seq', '+', 1) }))
          .where('key', '=', input.key)
          .returning('last_artifact_seq')
          .executeTakeFirst();
        if (allocated === undefined) {
          throw projectNotFound(input.key);
        }
        const seq = allocated.last_artifact_seq;
        const id = stemOf(input.key, seq);
        const timestamp = now();
        const content = stripTrailingNewline(input.content);
        const summary = input.summary ?? null;
        await tx
          .insertInto('artifact')
          .values({
            content,
            created_at: timestamp,
            id,
            project_key: input.key,
            seq,
            source_scratch: input.sourceScratch ?? null,
            summary,
            title: input.title,
            updated_at: timestamp,
          })
          .execute();
        await writeRelations(tx, [{ id, links: input.links, tags: input.tags }]);
        // Echoed IN FULL from what was just written (MMR-283): every field is
        // either the create input or derived here, so a caller building a
        // create response never needs a follow-up `load`. Tags and links carry
        // the read-back order so the echo equals the next load exactly.
        return {
          content,
          created_at: timestamp,
          key: input.key,
          links: [...new Set(input.links)].toSorted(),
          seq,
          summary,
          tags: [...new Set(input.tags)].toSorted(),
          title: input.title,
          updated_at: timestamp,
        };
      });
    },

    async findBySourceScratch(id) {
      const rows = await db
        .selectFrom('artifact')
        .selectAll()
        .where('source_scratch', '=', id)
        .orderBy('id')
        .execute();
      if (rows.length > 1) {
        throw invariant(`scratchpad ${id} produced more than one artifact`);
      }
      const row = rows[0];
      if (row === undefined) {
        return undefined;
      }
      const [record] = await decorate(db, [row]);
      return record === undefined ? undefined : { ...record, content: row.content };
    },

    async list(query: ArtifactListQuery) {
      let rows = await db
        .selectFrom('artifact')
        .selectAll()
        .$if(query.project !== undefined, (qb) => qb.where('project_key', '=', query.project ?? ''))
        .$if(query.excludeProjects !== undefined && query.excludeProjects.length > 0, (qb) =>
          qb.where('project_key', 'not in', query.excludeProjects ?? []),
        )
        // Newest-first, seq as the stable tiebreak (matches insertion order).
        .orderBy('created_at', 'desc')
        .orderBy('seq', 'desc')
        .execute();
      if (query.created !== undefined) {
        const created = query.created;
        rows = rows.filter((row) => withinWindow(created, row.created_at));
      }
      if (query.q !== undefined) {
        // Title-only and case-insensitive — the documented scope of `q`.
        const needle = query.q.toLowerCase();
        rows = rows.filter((row) => row.title.toLowerCase().includes(needle));
      }
      if (query.tag !== undefined) {
        const tagged = new Set(
          (
            await db
              .selectFrom('tag')
              .select('entity_id')
              .where('entity_type', '=', 'artifact')
              .where('tag', '=', query.tag)
              .execute()
          ).map((row) => row.entity_id),
        );
        rows = rows.filter((row) => tagged.has(row.id));
      }
      const total = rows.length;
      const offset = query.offset ?? 0;
      const page = rows.slice(offset, offset + (query.limit ?? 100));
      return { items: await decorate(db, page), total };
    },

    async listForNode(nodeStem) {
      const rows = await db
        .selectFrom('artifact')
        .innerJoin('artifact_link', 'artifact_link.artifact_id', 'artifact.id')
        .where('artifact_link.node_id', '=', nodeStem)
        .selectAll('artifact')
        .orderBy('artifact.seq')
        .execute();
      return decorate(db, rows);
    },

    async listForProject(key) {
      const rows = await db
        .selectFrom('artifact')
        .selectAll()
        .where('project_key', '=', key)
        .orderBy('seq')
        .execute();
      return decorate(db, rows);
    },

    async load(key, seq, opts) {
      const row = await rowOf(db, key, seq);
      if (row === undefined) {
        return undefined;
      }
      const [record] = await decorate(db, [row]);
      if (record === undefined) {
        return undefined;
      }
      return opts?.content === true ? { ...record, content: row.content } : record;
    },

    async removeTags(key, seq, tags) {
      if (tags.length === 0) {
        return 0;
      }
      return serializable(db, async (tx) => {
        const row = await rowOf(tx, key, seq);
        if (row === undefined) {
          return 0;
        }
        const deleted = await tx
          .deleteFrom('tag')
          .where('entity_type', '=', 'artifact')
          .where('entity_id', '=', row.id)
          .where('tag', 'in', tags)
          .executeTakeFirst();
        const removed = Number(deleted.numDeletedRows);
        // A no-op removal writes nothing — no row, no stamp.
        if (removed === 0) {
          return 0;
        }
        await tx
          .updateTable('artifact')
          .set({ updated_at: now() })
          .where('id', '=', row.id)
          .execute();
        return removed;
      });
    },

    async updateMetadata(key, seq, patch) {
      return serializable(db, async (tx) => {
        const row = await rowOf(tx, key, seq);
        if (row === undefined) {
          return false;
        }
        const changes: { title?: string; summary?: string | null } = {};
        if (patch.title !== undefined) {
          changes.title = patch.title;
        }
        if (patch.summary !== undefined) {
          changes.summary = patch.summary;
        }
        const changed =
          (changes.title !== undefined && changes.title !== row.title) ||
          (patch.summary !== undefined && patch.summary !== row.summary);
        // A patch that changes nothing still reports PRESENCE, and writes
        // nothing — clearing an already-absent summary is the reachable case.
        if (!changed) {
          return true;
        }
        await tx
          .updateTable('artifact')
          .set({ ...changes, updated_at: now() })
          .where('id', '=', row.id)
          .execute();
        return true;
      });
    },
  };
}
