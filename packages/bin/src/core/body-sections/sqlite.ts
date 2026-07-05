import type { Db } from '../context';
import type { BodySections, BodySectionStore } from './store';

/**
 * The SQLite body-section backend — the `transition_log` / `annotation` tables
 * read by surrogate `node_id`. Both facets project straight to the output
 * contract; the Norn backend produces the same views from the markdown sections
 * (see `./norn`). History orders by insertion (`id`), annotations by
 * `created_at` — the same order the vault's append log preserves.
 */
export function createSqliteBodySectionStore(db: Db): BodySectionStore {
  const readAnnotations: BodySectionStore['readAnnotations'] = async (nodeId) => {
    const rows = await db
      .selectFrom('annotation')
      .select(['content', 'created_at'])
      .where('node_id', '=', nodeId)
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map((r) => ({ content: r.content, createdAt: r.created_at }));
  };
  const readDescription: BodySectionStore['readDescription'] = async (nodeId) => {
    const row = await db
      .selectFrom('node')
      .select('description')
      .where('id', '=', nodeId)
      .executeTakeFirst();
    const text = row?.description?.trim() ?? '';
    return text === '' ? null : text;
  };
  const readHistory: BodySectionStore['readHistory'] = async (nodeId) => {
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
  };
  return {
    readAnnotations,
    readDescription,
    readHistory,
    // Per-facet source rows/columns — no shared body to batch, so this just runs
    // the requested reads (seam parity with the Norn backend's one-fetch slice).
    readSections: async (nodeId, stem, want) => {
      const sections: BodySections = {};
      if (want.description === true) {
        sections.description = await readDescription(nodeId, stem);
      }
      if (want.annotations === true) {
        sections.annotations = await readAnnotations(nodeId, stem);
      }
      if (want.history === true) {
        sections.history = await readHistory(nodeId, stem);
      }
      return sections;
    },
  };
}
