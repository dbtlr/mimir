import { invariant } from '../errors';

/**
 * Multi-row INSERTs and `IN` lists under a dialect's bind-parameter ceiling
 * (MMR-380, `StoreDialect.maxParameters`).
 *
 * The store import writes whole collections at once, and a row-at-a-time insert
 * spends one client/server round trip per record — the cost that dominates an
 * import of a real board, where the rows number in the tens of thousands. One
 * statement per table would be better still, except that a single statement may
 * carry only so many bind parameters and the import's row count is the SOURCE
 * store's, which has no bound at all.
 *
 * So a batch is chunked by the row's own width. The parameters one row spends
 * is its column count, which is read off the first row rather than assumed:
 * every batch here is built uniformly, so one row's shape is the batch's. That
 * uniformity is checked rather than trusted — a batch built with a conditional
 * key would chunk against the wrong width and blow the ceiling on a big import,
 * a fault that never shows on a small one.
 */

/**
 * The safety factor on the ceiling. Halving it costs nothing measurable — even
 * the widest row here (a node's ~26 columns) still puts over a thousand rows in
 * one statement — and it leaves room for a driver or a query builder that
 * spends a parameter the column count does not predict.
 */
const MARGIN = 2;

/** Rows per statement for a row of `columns` columns under `maxParameters` — at least one. */
export function rowsPerStatement(columns: number, maxParameters: number): number {
  return Math.max(1, Math.floor(maxParameters / MARGIN / Math.max(1, columns)));
}

/**
 * Insert `rows` through `insert`, one statement per chunk. An empty batch runs
 * no statement at all — `INSERT INTO t VALUES` with no rows is not a query.
 */
export async function insertBatched<R extends object>(
  rows: readonly R[],
  maxParameters: number,
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
  for (const chunk of chunked(rows, rowsPerStatement(columns, maxParameters))) {
    await insert(chunk);
  }
}

/**
 * `values` cut into the lists one `IN (...)` read may bind, when each value
 * costs `perValue` parameters (a value matched against two columns costs two).
 * A read over every stem of a store — the export's body sections — has the
 * same unbounded width an import's insert has.
 */
export function inLists<T>(values: readonly T[], maxParameters: number, perValue = 1): T[][] {
  return chunked(values, rowsPerStatement(perValue, maxParameters));
}

function chunked<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    chunks.push(values.slice(start, start + size));
  }
  return chunks;
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
