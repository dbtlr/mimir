import type { PGlite } from '@electric-sql/pglite';
import {
  CompiledQuery,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type {
  DatabaseConnection,
  Dialect,
  DialectAdapter,
  Driver,
  QueryResult,
  TransactionSettings,
} from 'kysely';

/**
 * An in-process Kysely dialect over PGlite — real PostgreSQL (18.x, compiled to
 * WASM) with no server, no port, and no cleanup beyond dropping the object.
 *
 * Shipped code rather than a test helper because it is the only backend the
 * conformance suite can run everywhere: the real-Postgres lane needs a server
 * on the runner, and a suite that skips on CI proves nothing. PGlite speaks the
 * same SQL, enforces the same constraints, and raises the same SQLSTATEs, so a
 * behavior proven here is a behavior of the backend.
 */

/** PGlite executes one statement at a time; a stream has no meaning here. */
const NO_STREAMING = 'the PGlite dialect does not support streaming queries';

class PgliteConnection implements DatabaseConnection {
  private readonly pg: PGlite;

  constructor(pg: PGlite) {
    this.pg = pg;
  }

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.pg.query<R>(compiled.sql, [...compiled.parameters]);
    return { numAffectedRows: BigInt(result.affectedRows ?? 0), rows: result.rows };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error(NO_STREAMING);
  }
}

/**
 * PGlite is ONE session. The driver therefore hands the same connection to every
 * caller instead of queueing them behind a lock, which matters for more than
 * simplicity: the core legitimately takes a `Store`-level read while a
 * `transact` is open (a `## Next` re-authoring reads the current section before
 * writing it), and a pool-shaped driver would answer that read on a second
 * connection. Here there is no second connection, so a lock would deadlock and
 * sharing is the only behavior that works — the read simply joins the open
 * transaction, which is a strictly fresher answer.
 *
 * Sharing one session means a nested `transaction()` really is nested, so the
 * driver tracks depth and maps the inner scopes onto savepoints. Without that,
 * an inner COMMIT would commit the outer scope.
 *
 * What this dialect does NOT offer is concurrency: two overlapping transactions
 * would interleave on the one session. Tests drive it sequentially, and the
 * concurrency contract belongs to the real-Postgres lane, where a pool and a
 * server make it a real question.
 */
class PgliteDriver implements Driver {
  private readonly connection: PgliteConnection;
  private readonly pg: PGlite;
  private depth = 0;

  constructor(pg: PGlite) {
    this.connection = new PgliteConnection(pg);
    this.pg = pg;
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    // The isolation level rides the BEGIN itself rather than a follow-up SET:
    // `transact` asks for SERIALIZABLE and the whole retry contract (SQLSTATE
    // 40001) depends on the level being in force from the first statement.
    const level = settings.isolationLevel;
    const begin = level === undefined ? 'begin' : `begin isolation level ${level}`;
    const statement = this.depth > 0 ? `savepoint ${savepointName(this.depth)}` : begin;
    await connection.executeQuery(CompiledQuery.raw(statement));
    this.depth += 1;
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    this.depth -= 1;
    await connection.executeQuery(
      CompiledQuery.raw(
        this.depth > 0 ? `release savepoint ${savepointName(this.depth)}` : 'commit',
      ),
    );
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    this.depth -= 1;
    await connection.executeQuery(
      CompiledQuery.raw(
        this.depth > 0 ? `rollback to savepoint ${savepointName(this.depth)}` : 'rollback',
      ),
    );
  }

  acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve(this.connection);
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  releaseConnection(): Promise<void> {
    return Promise.resolve();
  }

  async destroy(): Promise<void> {
    await this.pg.close();
  }
}

/** The savepoint one nesting level maps onto. */
function savepointName(depth: number): string {
  return `mimir_sp_${String(depth)}`;
}

/** A Kysely {@link Dialect} over an already-constructed PGlite database. */
export function createPgliteDialect(pg: PGlite): Dialect {
  return {
    createAdapter: (): DialectAdapter => new PostgresAdapter(),
    createDriver: () => new PgliteDriver(pg),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}
