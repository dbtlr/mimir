import type { Db } from './context';
import type { Store, WorkingSet } from './store';

/**
 * The SQLite `Store` (ADR 0016 Phase 0) — the seam's first backend: four
 * bulk selects over the existing Kysely handle, no per-node follow-ups. It
 * lives in `core/` (not `db/`) because the layering runs contract ← db ←
 * core: the interface is core vocabulary and db may not import core.
 */
export function createSqliteStore(db: Db): Store {
  return {
    db,
    async loadWorkingSet(): Promise<WorkingSet> {
      const [projects, nodes, edges, tagRows] = await Promise.all([
        db.selectFrom('project').selectAll().orderBy('key', 'asc').execute(),
        db.selectFrom('node').selectAll().execute(),
        db.selectFrom('dependency').selectAll().execute(),
        db
          .selectFrom('tag')
          .select(['entity_id', 'tag'])
          .where('entity_type', '=', 'node')
          .orderBy('created_at', 'asc')
          .execute(),
      ]);
      const nodeTags = new Map<number, string[]>();
      for (const row of tagRows) {
        const tags = nodeTags.get(row.entity_id);
        if (tags === undefined) {
          nodeTags.set(row.entity_id, [row.tag]);
        } else {
          tags.push(row.tag);
        }
      }
      return { edges, nodeTags, nodes, projects };
    },
  };
}
