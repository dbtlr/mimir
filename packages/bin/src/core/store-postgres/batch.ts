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
 * every batch here is built uniformly, so one row's shape is the batch's.
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
  const perStatement = rowsPerStatement(Object.keys(first).length);
  for (let start = 0; start < rows.length; start += perStatement) {
    await insert(rows.slice(start, start + perStatement));
  }
}
