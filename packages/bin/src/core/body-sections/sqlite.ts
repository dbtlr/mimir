import type { Db } from '../context';
import type { BodySectionStore } from './store';

/**
 * The SQLite body-section backend — the `transition_log` / `annotation` tables
 * read by surrogate `node_id`. Both facets project straight to the output
 * contract; the Norn backend produces the same views from the markdown sections
 * (see `./norn`). History orders by insertion (`id`), annotations by
 * `created_at` — the same order the vault's append log preserves.
 */
export function createSqliteBodySectionStore(db: Db): BodySectionStore {
  return {
    readAnnotations: async (nodeId) => {
      const rows = await db
        .selectFrom('annotation')
        .select(['content', 'created_at'])
        .where('node_id', '=', nodeId)
        .orderBy('created_at', 'asc')
        .execute();
      return rows.map((r) => ({ content: r.content, createdAt: r.created_at }));
    },
    readDescription: async (nodeId) => {
      const row = await db
        .selectFrom('node')
        .select('description')
        .where('id', '=', nodeId)
        .executeTakeFirst();
      const text = row?.description?.trim() ?? '';
      return text === '' ? null : text;
    },
    readHistory: async (nodeId) => {
      const rows = await db
        .selectFrom('transition_log')
        .select(['kind', 'from_value', 'to_value', 'at', 'reason'])
        .where('node_id', '=', nodeId)
        .orderBy('id', 'asc')
        .execute();
      return rows.map((r) => ({
        at: r.at,
        from: r.from_value,
        kind: r.kind,
        reason: r.reason,
        to: r.to_value,
      }));
    },
  };
}
