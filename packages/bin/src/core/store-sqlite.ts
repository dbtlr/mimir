import { allocateArtifactSeq, allocateSeq } from './allocation';
import type { Db, Tx } from './context';
import type { NodeTag, Store, StoreWriter, WorkingSet } from './store';

/**
 * The SQLite `Store` (ADR 0016 Phase 0) — the seam's first backend: four
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
export async function loadWorkingSet(executor: Db | Tx): Promise<WorkingSet> {
  const [projects, nodes, edges, tagRows] = await Promise.all([
    executor.selectFrom('project').selectAll().orderBy('key', 'asc').execute(),
    executor.selectFrom('node').selectAll().execute(),
    executor.selectFrom('dependency').selectAll().execute(),
    executor
      .selectFrom('tag')
      .select(['entity_id', 'tag', 'note', 'created_at'])
      .where('entity_type', '=', 'node')
      .orderBy('created_at', 'asc')
      .execute(),
  ]);
  const nodeTags = new Map<number, NodeTag[]>();
  for (const row of tagRows) {
    const record: NodeTag = { created_at: row.created_at, note: row.note, tag: row.tag };
    const tags = nodeTags.get(row.entity_id);
    if (tags === undefined) {
      nodeTags.set(row.entity_id, [record]);
    } else {
      tags.push(record);
    }
  }
  return { edges, nodeTags, nodes, projects };
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
    insertNode: (row) => tx.insertInto('node').values(row).returningAll().executeTakeFirstOrThrow(),
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
    loadNode: (id) => tx.selectFrom('node').selectAll().where('id', '=', id).executeTakeFirst(),
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
    db,
    loadWorkingSet: () => loadWorkingSet(db),
    transact: (fn) => db.transaction().execute((tx) => fn(createWriter(tx))),
  };
}
