import { invariant } from '../errors';

/**
 * Multi-row INSERTs under PostgreSQL's bind-parameter ceiling (MMR-380).
 *
 * The store import writes whole collections at once, and a row-at-a-time insert
 * spends one client/server round trip per record — the cost that dominates an
 * import of a real board, where the rows number in the tens of thousands. One
 * statement per table would be better still, except that a single statement may
 * carry at most 65535 bind parameters and the import's row count is the SOURCE
 * store's, which has no bound at all.
 *
 * So a batch is chunked by the row's own width. The parameters one row spends
 * is its column count, which is read off the first row rather than assumed:
 * every batch here is built uniformly, so one row's shape is the batch's. That
 * uniformity is checked rather than trusted — a batch built with a conditional
 * key would chunk against the wrong width and blow the ceiling on a big import,
 * a fault that never shows on a small one.
 */

/** The bind parameters one PostgreSQL statement may carry. */
const MAX_BIND_PARAMETERS = 65535;

/**
 * The safety factor on the ceiling. Halving it costs nothing measurable — even
 * the widest row here (a node's ~26 columns) still puts over a thousand rows in
 * one statement — and it leaves room for a driver or a query builder that
 * spends a parameter the column count does not predict.
 */
const MARGIN = 2;

/** Rows per statement for a row of `columns` columns — at least one. */
export function rowsPerStatement(columns: number): number {
  return Math.max(1, Math.floor(MAX_BIND_PARAMETERS / MARGIN / Math.max(1, columns)));
}

/**
 * Insert `rows` through `insert`, one statement per chunk. An empty batch runs
 * no statement at all — `INSERT INTO t VALUES` with no rows is not a query.
 */
export async function insertBatched<R extends object>(
  rows: readonly R[],
  insert: (chunk: R[]) => Promise<unknown>,
): Promise<void> {
  const first = rows.at(0);
  if (first === undefined) {
    return;
  }
  const columns = Object.keys(first).length;
  // Cheap next to the statements it guards: one key count per row.
  for (const [index, row] of rows.entries()) {
    if (Object.keys(row).length !== columns) {
      throw invariant(
        `a batched insert was given rows of differing width: row ${String(index)} has ${String(Object.keys(row).length)} columns, the first has ${String(columns)}`,
        'every row of one batch must carry the same keys — the chunk size is computed from the first row',
      );
    }
  }
  const perStatement = rowsPerStatement(columns);
  for (let start = 0; start < rows.length; start += perStatement) {
    await insert(rows.slice(start, start + perStatement));
  }
}

/**
 * A pair-keyed dedupe key, unambiguous whatever the two values contain — the
 * one spelling for "this row is already in the batch" (an artifact's tag or
 * link, an import's dependency edge). Deduping before the batch keeps a repeat
 * from spending bind parameters, which are the budget the chunking above is
 * computed against.
 */
export function pairKey(left: string, right: string): string {
  return JSON.stringify([left, right]);
}
