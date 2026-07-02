import type { Db, Tx } from './context';
import type { NodeTag, Store, WorkingSet } from './store';

/**
 * The SQLite `Store` (ADR 0016 Phase 0) — the seam's first backend: four
 * bulk selects over the existing Kysely handle, no per-node follow-ups. It
 * lives in `core/` (not `db/`) because the layering runs contract ← db ←
 * core: the interface is core vocabulary and db may not import core.
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

export function createSqliteStore(db: Db): Store {
  return {
    db,
    loadWorkingSet: () => loadWorkingSet(db),
  };
}
