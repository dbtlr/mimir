import type { Db } from '../context';
import { validation } from '../errors';
import { renderNodeId, renderProjectKey } from '../lookup';
import type { TransitionsFeed } from './store';

/**
 * Render the entity a transition row belongs to (ADR 0015): a node-keyed row
 * yields its `KEY-seq`, an archive row its project `KEY` — both valid identity
 * tokens for the `node` field of the cross-node transitions read.
 */
async function renderTransitionEntity(
  db: Db,
  row: { node_id: number | null; project_id: number | null },
): Promise<string> {
  if (row.node_id !== null) {
    return (await renderNodeId(db, row.node_id)) ?? 'unknown';
  }
  if (row.project_id !== null) {
    return (await renderProjectKey(db, row.project_id)) ?? 'unknown';
  }
  return 'unknown';
}

/**
 * The SQLite transition feed — the append-only `transition_log` read in id
 * order, resumed by the integer id cursor: entries strictly after `since`, the
 * cursor set to the last row's id. Node ids render lazily per row.
 */
export function createSqliteTransitionsFeed(db: Db): TransitionsFeed {
  return {
    list: async (opts = {}) => {
      let after = 0;
      if (opts.since !== undefined) {
        after = Number(opts.since);
        if (!Number.isInteger(after) || after < 0) {
          throw validation(
            `invalid cursor ${opts.since}`,
            'pass back a next_cursor you were given',
          );
        }
      }
      let query = db
        .selectFrom('transition_log')
        .selectAll()
        .where('id', '>', after)
        .orderBy('id', 'asc');
      if (opts.limit !== undefined) {
        if (!Number.isInteger(opts.limit) || opts.limit < 1) {
          throw validation(`invalid limit ${String(opts.limit)}`);
        }
        query = query.limit(opts.limit);
      }
      const rows = await query.execute();
      const items = await Promise.all(
        rows.map(async (row) => ({
          at: row.at,
          from: row.from_value,
          kind: row.kind,
          node: await renderTransitionEntity(db, row),
          reason: row.reason,
          to: row.to_value,
        })),
      );
      const last = rows.at(-1);
      return last === undefined ? { items } : { items, nextCursor: String(last.id) };
    },
  };
}
