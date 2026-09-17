import type { TransitionView } from '@mimir/contract';
import { sql } from 'kysely';

import { validation } from '../errors';
import type { TransitionsFeed } from '../transitions/store';
import { toRowId } from './schema';
import type { Executor } from './tx';

/**
 * The Postgres transition feed (ADR 0016 Phase 3). Unlike the Norn feed — which
 * fans every document's `## History` out of the vault and merges them on a
 * best-effort `at` order (MMR-168) — this reads ONE append-only table with a
 * real insertion sequence, so the order is true and the cursor is monotonic.
 *
 * The cursor stays opaque and the same shape of promise holds: pass back what
 * you were given, and you resume strictly after it.
 */

const SEP = '|';

type Cursor = { at: string; id: number };

function encodeCursor(cursor: Cursor): string {
  return `${cursor.at}${SEP}${String(cursor.id)}`;
}

/** Decode a resume cursor; a malformed token is a caller error, not a miss. */
function decodeCursor(since: string): Cursor {
  const [at, rawId, ...rest] = since.split(SEP);
  const id = Number(rawId);
  if (
    at === undefined ||
    at === '' ||
    rawId === undefined ||
    rawId === '' ||
    rest.length > 0 ||
    !Number.isInteger(id)
  ) {
    throw validation(`invalid cursor ${since}`, 'pass back a next_cursor you were given');
  }
  return { at, id };
}

export function createPostgresTransitionsFeed(ex: Executor): TransitionsFeed {
  return {
    list: async (opts = {}) => {
      if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
        throw validation(`invalid limit ${String(opts.limit)}`);
      }
      // An absent OR empty `since` reads from the start.
      const after =
        opts.since === undefined || opts.since === '' ? undefined : decodeCursor(opts.since);
      let query = ex
        .selectFrom('transition_log')
        .select(['id', 'node_id', 'project_key', 'kind', 'from_value', 'to_value', 'reason', 'at'])
        .orderBy('at')
        .orderBy('id');
      if (after !== undefined) {
        // Strictly after the cursor's row on the composite (at, id) order — a
        // SQL row-value comparison, which is exactly the tuple order the ORDER
        // BY imposes rather than a hand-expanded re-statement of it.
        query = query.where(sql<boolean>`(at, id) > (${after.at}, ${after.id}::bigint)`);
      }
      if (opts.limit !== undefined) {
        query = query.limit(opts.limit);
      }
      const rows = await query.execute();
      const items = rows.map(
        (row): TransitionView => ({
          at: row.at,
          from: row.from_value,
          kind: row.kind,
          // Entity-keyed (ADR 0015): exactly one of the two is set.
          node: row.node_id ?? row.project_key ?? '',
          reason: row.reason,
          to: row.to_value,
        }),
      );
      const last = rows.at(-1);
      return last === undefined
        ? { items }
        : { items, nextCursor: encodeCursor({ at: last.at, id: toRowId(last.id) }) };
    },
  };
}
