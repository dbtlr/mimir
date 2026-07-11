import { sql } from 'kysely';

import type { Db } from '../context';
import { parseIdentity } from '../ids';
import type { ArtifactCreate, ArtifactListQuery, ArtifactRecord, ArtifactStore } from './store';

/**
 * The SQLite `ArtifactStore` — the existing artifact queries lifted behind
 * the seam (MMR-143), behavior-preserving: numeric ids stay the join hub for
 * `artifact_link` and `tag` rows *inside* this file, and stop at its edge.
 */

const DEFAULT_LIMIT = 100;

type Executor = Pick<Db, 'selectFrom' | 'insertInto' | 'updateTable' | 'deleteFrom'>;

async function tagsOf(tx: Executor, artifactId: number): Promise<string[]> {
  const rows = await tx
    .selectFrom('tag')
    .select('tag')
    .where('entity_type', '=', 'artifact')
    .where('entity_id', '=', artifactId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map((r) => r.tag);
}

async function linksOf(tx: Executor, artifactId: number): Promise<string[]> {
  const rows = await tx
    .selectFrom('artifact_link')
    .innerJoin('node', 'node.id', 'artifact_link.node_id')
    .innerJoin('project', 'project.id', 'node.project_id')
    .select(['project.key as key', 'node.seq as seq'])
    .where('artifact_link.artifact_id', '=', artifactId)
    .orderBy('artifact_link.node_id', 'asc')
    .execute();
  return rows.map((r) => `${r.key}-${String(r.seq)}`);
}

/** The artifact row + project key for one external identity, or undefined. */
async function rowByRef(tx: Executor, key: string, seq: number) {
  return tx
    .selectFrom('artifact')
    .innerJoin('project', 'project.id', 'artifact.project_id')
    .select([
      'artifact.id as id',
      'artifact.seq as seq',
      'artifact.title as title',
      'artifact.content as content',
      'artifact.created_at as created_at',
      'project.key as key',
    ])
    .where('project.key', '=', key)
    .where('artifact.seq', '=', seq)
    .executeTakeFirst();
}

export function createSqliteArtifactStore(db: Db): ArtifactStore {
  // Only `load` (the artifact detail) surfaces links; the list/facet paths
  // drop them (they render title/tags/id only), so the link join is fetched
  // on demand, not per row — parity with the pre-seam queries.
  const record = async (
    tx: Executor,
    row: { id: number; key: string; seq: number; title: string; created_at: string },
    withLinks = false,
  ): Promise<ArtifactRecord> => ({
    created_at: row.created_at,
    key: row.key,
    links: withLinks ? await linksOf(tx, row.id) : [],
    seq: row.seq,
    tags: await tagsOf(tx, row.id),
    title: row.title,
  });

  return {
    async applyTag(key, seq, tag, note) {
      const row = await rowByRef(db, key, seq);
      if (row === undefined) {
        return;
      }
      if (note === null) {
        await db
          .insertInto('tag')
          .values({ entity_id: row.id, entity_type: 'artifact', note, tag })
          .onConflict((oc) => oc.columns(['entity_type', 'entity_id', 'tag']).doNothing())
          .execute();
      } else {
        await db
          .insertInto('tag')
          .values({ entity_id: row.id, entity_type: 'artifact', note, tag })
          .onConflict((oc) => oc.columns(['entity_type', 'entity_id', 'tag']).doUpdateSet({ note }))
          .execute();
      }
    },

    async create(input: ArtifactCreate) {
      return db.transaction().execute(async (tx) => {
        const project = await tx
          .selectFrom('project')
          .select(['id'])
          .where('key', '=', input.key)
          .executeTakeFirstOrThrow();
        const { last_artifact_seq: seq } = await tx
          .updateTable('project')
          .set((eb) => ({ last_artifact_seq: eb('last_artifact_seq', '+', 1) }))
          .where('id', '=', project.id)
          .returning('last_artifact_seq')
          .executeTakeFirstOrThrow();
        const artifact = await tx
          .insertInto('artifact')
          .values({ content: input.content, project_id: project.id, seq, title: input.title })
          .returning('id')
          .executeTakeFirstOrThrow();
        for (const tag of input.tags) {
          await tx
            .insertInto('tag')
            .values({ entity_id: artifact.id, entity_type: 'artifact', note: null, tag })
            .onConflict((oc) => oc.columns(['entity_type', 'entity_id', 'tag']).doNothing())
            .execute();
        }
        for (const stem of input.links) {
          const identity = parseIdentity(stem);
          if (identity?.kind !== 'node') {
            continue; // the verb validated stems; a non-node here is unreachable
          }
          const node = await tx
            .selectFrom('node')
            .innerJoin('project', 'project.id', 'node.project_id')
            .select('node.id as id')
            .where('project.key', '=', identity.key)
            .where('node.seq', '=', identity.seq)
            .executeTakeFirstOrThrow();
          await tx
            .insertInto('artifact_link')
            .values({ artifact_id: artifact.id, node_id: node.id })
            .onConflict((oc) => oc.columns(['artifact_id', 'node_id']).doNothing())
            .execute();
        }
        return { key: input.key, seq };
      });
    },

    async list(query: ArtifactListQuery) {
      let base = db
        .selectFrom('artifact')
        .innerJoin('project', 'project.id', 'artifact.project_id');
      if (query.excludeProjects !== undefined && query.excludeProjects.length > 0) {
        base = base.where('project.key', 'not in', query.excludeProjects);
      }
      if (query.project !== undefined) {
        base = base.where('project.key', '=', query.project);
      }
      if (query.since !== undefined) {
        base = base.where('artifact.created_at', '>=', query.since);
      }
      if (query.before !== undefined) {
        base = base.where('artifact.created_at', '<=', query.before);
      }
      if (query.q !== undefined) {
        const like = `%${query.q.toLowerCase()}%`;
        base = base.where(
          sql<boolean>`(lower(artifact.title) LIKE ${like} OR lower(artifact.content) LIKE ${like})`,
        );
      }
      if (query.tag !== undefined) {
        const tag = query.tag;
        base = base.where('artifact.id', 'in', (qb) =>
          qb
            .selectFrom('tag')
            .select('entity_id')
            .where('entity_type', '=', 'artifact')
            .where('tag', '=', tag),
        );
      }
      const { c } = await base
        .select((eb) => eb.fn.countAll<number>().as('c'))
        .executeTakeFirstOrThrow();
      const rows = await base
        .select([
          'artifact.id as id',
          'artifact.seq as seq',
          'project.key as key',
          'artifact.title as title',
          'artifact.created_at as created_at',
        ])
        .orderBy('artifact.created_at', 'desc')
        .orderBy('artifact.id', 'desc')
        .limit(query.limit ?? DEFAULT_LIMIT)
        .offset(query.offset ?? 0)
        .execute();
      const items: ArtifactRecord[] = [];
      for (const row of rows) {
        items.push(await record(db, row));
      }
      return { items, total: c };
    },

    async listForNode(nodeStem: string) {
      const identity = parseIdentity(nodeStem);
      if (identity?.kind !== 'node') {
        return [];
      }
      const rows = await db
        .selectFrom('artifact_link')
        .innerJoin('artifact', 'artifact.id', 'artifact_link.artifact_id')
        .innerJoin('project', 'project.id', 'artifact.project_id')
        .innerJoin('node', 'node.id', 'artifact_link.node_id')
        .innerJoin('project as node_project', 'node_project.id', 'node.project_id')
        .select([
          'artifact.id as id',
          'artifact.seq as seq',
          'artifact.title as title',
          'artifact.created_at as created_at',
          'project.key as key',
        ])
        .where('node_project.key', '=', identity.key)
        .where('node.seq', '=', identity.seq)
        .orderBy('artifact.seq', 'asc')
        .execute();
      const out: ArtifactRecord[] = [];
      for (const row of rows) {
        out.push(await record(db, row));
      }
      return out;
    },

    async listForProject(key: string) {
      const rows = await db
        .selectFrom('artifact')
        .innerJoin('project', 'project.id', 'artifact.project_id')
        .select([
          'artifact.id as id',
          'artifact.seq as seq',
          'artifact.title as title',
          'artifact.created_at as created_at',
          'project.key as key',
        ])
        .where('project.key', '=', key)
        .orderBy('artifact.seq', 'asc')
        .execute();
      const out: ArtifactRecord[] = [];
      for (const row of rows) {
        out.push(await record(db, row));
      }
      return out;
    },

    async load(key, seq, opts) {
      const row = await rowByRef(db, key, seq);
      if (row === undefined) {
        return undefined;
      }
      const base = await record(db, row, true); // load surfaces links
      return opts?.content === true ? { ...base, content: row.content } : base;
    },

    async removeTags(key, seq, tags) {
      const row = await rowByRef(db, key, seq);
      if (row === undefined || tags.length === 0) {
        return 0;
      }
      const result = await db
        .deleteFrom('tag')
        .where('entity_type', '=', 'artifact')
        .where('entity_id', '=', row.id)
        .where('tag', 'in', tags)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },

    async updateTitle(key, seq, title) {
      const row = await rowByRef(db, key, seq);
      if (row === undefined) {
        return false;
      }
      await db.updateTable('artifact').set({ title }).where('id', '=', row.id).execute();
      return true;
    },
  };
}
