import { allocateArtifactSeq, allocateSeq } from './allocation';
import { createSqliteArtifactStore } from './artifacts/sqlite';
import type { ArtifactStore } from './artifacts/store';
import { createSqliteBodySectionStore } from './body-sections/sqlite';
import type { Db, Tx } from './context';
import type { NodeTag, Store, StoreWriter, WorkingSet } from './store';
import { createSqliteTransitionsFeed } from './transitions/sqlite';

/**
 * The SQLite `Store` (ADR 0016 Phase 0) — the seam's first backend: five
 * bulk selects over the existing Kysely handle, no per-node follow-ups, and
 * a `transact` scope whose writer methods are thin Kysely calls on the
 * transaction. It lives in `core/` (not `db/`) because the layering runs
 * contract ← db ← core: the interface is core vocabulary and db may not
 * import core.
 */

/**
 * The bulk projection itself, callable on any executor — the write verbs
 * load a fresh working set *inside* their transaction (a `Tx` is a
 * `Kysely<DB>`), so guard derivation sees in-tx state.
 */
/** Group `(entity_id, tag)` rows into an entity-id → tag-record map, in row order. */
function groupTags(
  rows: readonly { entity_id: number; tag: string; note: string | null; created_at: string }[],
): Map<number, NodeTag[]> {
  const byEntity = new Map<number, NodeTag[]>();
  for (const row of rows) {
    const record: NodeTag = { created_at: row.created_at, note: row.note, tag: row.tag };
    const tags = byEntity.get(row.entity_id);
    if (tags === undefined) {
      byEntity.set(row.entity_id, [record]);
    } else {
      tags.push(record);
    }
  }
  return byEntity;
}

/**
 * SQLite has no boolean type, so `open_ended` comes back off `selectAll` as
 * 0/1/NULL. Coerce it to a real boolean (preserving NULL) at every node-read
 * boundary, so the model (`boolean | null`) and the Norn backend — which decodes
 * a real boolean — agree, and the SQLite↔Norn parity harness stays green (MMR-204).
 */
function coerceBool(value: unknown): boolean | null {
  return value === null || value === undefined ? null : Boolean(value);
}
function coerceNodeRow<T extends { open_ended: boolean | null }>(row: T): T {
  return { ...row, open_ended: coerceBool(row.open_ended) };
}

export async function loadWorkingSet(executor: Db | Tx): Promise<WorkingSet> {
  const [projects, nodes, edges, nodeTagRows, projectTagRows] = await Promise.all([
    executor.selectFrom('project').selectAll().orderBy('key', 'asc').execute(),
    executor.selectFrom('node').selectAll().execute(),
    executor.selectFrom('dependency').selectAll().execute(),
    executor
      .selectFrom('tag')
      .select(['entity_id', 'tag', 'note', 'created_at'])
      .where('entity_type', '=', 'node')
      .orderBy('created_at', 'asc')
      .orderBy('tag', 'asc')
      .execute(),
    executor
      .selectFrom('tag')
      .select(['entity_id', 'tag', 'note', 'created_at'])
      .where('entity_type', '=', 'project')
      .orderBy('created_at', 'asc')
      .orderBy('tag', 'asc')
      .execute(),
  ]);
  return {
    edges,
    nodeTags: groupTags(nodeTagRows),
    nodes: nodes.map(coerceNodeRow),
    projectTags: groupTags(projectTagRows),
    projects,
  };
}

/** The write vocabulary over one transaction — each method one thin Kysely call. */
function createWriter(tx: Tx): StoreWriter {
  return {
    allocateArtifactSeq: (projectId) => allocateArtifactSeq(tx, projectId),
    allocateSeq: (projectId) => allocateSeq(tx, projectId),
    appendTransition: async (row) => {
      await tx.insertInto('transition_log').values(row).execute();
    },
    deleteDependency: async (edge) => {
      const result = await tx
        .deleteFrom('dependency')
        .where('node_id', '=', edge.node_id)
        .where('depends_on_node_id', '=', edge.depends_on_node_id)
        .executeTakeFirst();
      return result.numDeletedRows > 0n;
    },
    deleteTags: async (entityType, entityId, tags) => {
      const result = await tx
        .deleteFrom('tag')
        .where('entity_type', '=', entityType)
        .where('entity_id', '=', entityId)
        .where('tag', 'in', tags)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
    insertAnnotation: async (row) => {
      await tx.insertInto('annotation').values(row).execute();
    },
    insertArtifact: (row) =>
      tx.insertInto('artifact').values(row).returning('id').executeTakeFirstOrThrow(),
    insertDependency: async (edge) => {
      await tx.insertInto('dependency').values(edge).execute();
    },
    insertNode: async (row) =>
      coerceNodeRow(
        await tx.insertInto('node').values(row).returningAll().executeTakeFirstOrThrow(),
      ),
    insertProject: (row) =>
      tx.insertInto('project').values(row).returningAll().executeTakeFirstOrThrow(),
    insertTag: async (row) => {
      await tx
        .insertInto('tag')
        .values(row)
        .onConflict((oc) => oc.columns(['entity_type', 'entity_id', 'tag']).doNothing())
        .execute();
    },
    linkArtifact: async (artifactId, nodeId) => {
      await tx
        .insertInto('artifact_link')
        .values({ artifact_id: artifactId, node_id: nodeId })
        .execute();
    },
    listChildren: async (parentId) => {
      const rows = await tx
        .selectFrom('node')
        .select('id')
        .where('parent_id', '=', parentId)
        .execute();
      return rows.map((r) => r.id);
    },
    listPrereqsOf: async (nodeId) => {
      const rows = await tx
        .selectFrom('dependency')
        .select('depends_on_node_id')
        .where('node_id', '=', nodeId)
        .execute();
      return rows.map((r) => r.depends_on_node_id);
    },
    listRankedTasks: async (projectId) => {
      const rows = await tx
        .selectFrom('node')
        .select(['id', 'rank', 'seq'])
        .where('project_id', '=', projectId)
        .where('rank', 'is not', null)
        .orderBy('rank', 'asc')
        .orderBy('seq', 'asc')
        .execute();
      return rows.flatMap((r) => (r.rank === null ? [] : [{ id: r.id, rank: r.rank, seq: r.seq }]));
    },
    loadArtifact: (id) =>
      tx.selectFrom('artifact').selectAll().where('id', '=', id).executeTakeFirst(),
    loadNode: async (id) => {
      const row = await tx.selectFrom('node').selectAll().where('id', '=', id).executeTakeFirst();
      return row === undefined ? undefined : coerceNodeRow(row);
    },
    loadProject: (id) =>
      tx.selectFrom('project').selectAll().where('id', '=', id).executeTakeFirst(),
    loadProjectByKey: (key) =>
      tx.selectFrom('project').selectAll().where('key', '=', key).executeTakeFirst(),
    loadWorkingSet: () => loadWorkingSet(tx),
    updateArtifact: async (id, patch) => {
      await tx.updateTable('artifact').set(patch).where('id', '=', id).execute();
    },
    updateNode: async (id, patch) => {
      await tx.updateTable('node').set(patch).where('id', '=', id).execute();
    },
    updateProject: async (id, patch) => {
      await tx.updateTable('project').set(patch).where('id', '=', id).execute();
    },
    upsertTagNote: async (row) => {
      await tx
        .insertInto('tag')
        .values(row)
        .onConflict((oc) =>
          oc.columns(['entity_type', 'entity_id', 'tag']).doUpdateSet({ note: row.note }),
        )
        .execute();
    },
  };
}

export function createSqliteStore(db: Db): Store {
  return {
    artifacts: createSqliteArtifactStore(db),
    bodySections: createSqliteBodySectionStore(db),
    // Run the five bulk selects inside one read transaction so the projection is
    // a consistent snapshot — a concurrent write can't interleave between them.
    // The writer's own `loadWorkingSet` already runs inside its `transact` tx.
    loadWorkingSet: () => db.transaction().execute((tx) => loadWorkingSet(tx)),
    transact: (fn) => db.transaction().execute((tx) => fn(createWriter(tx))),
    transitions: createSqliteTransitionsFeed(db),
  };
}

/**
 * The store with its artifact slice swapped for another backend (MMR-143,
 * behind the backend flag): nodes, projects, and every verb stay put;
 * artifacts read and write through the given slice.
 */
export function withArtifactStore(base: Store, artifacts: ArtifactStore): Store {
  return { ...base, artifacts };
}
