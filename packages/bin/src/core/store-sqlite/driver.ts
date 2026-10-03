import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';

import { CompiledQuery, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import type {
  DatabaseConnection,
  Dialect,
  DialectAdapter,
  Driver,
  QueryResult,
  TransactionSettings,
} from 'kysely';

import { invariant } from '../errors';

/**
 * A Kysely dialect over `bun:sqlite` — the connection under the SQLite store
 * (ADR 0032).
 *
 * Kysely's own SQLite dialect is written against another library's statement
 * interface and opens every transaction with a plain `BEGIN`. The store needs
 * `BEGIN IMMEDIATE` for writes (ADR 0032 Decision 3): a deferred transaction
 * that reads and then writes upgrades its lock mid-flight, and two processes
 * doing that at once deadlock — one of them fails `SQLITE_BUSY` without the
 * busy timeout ever being consulted. An immediate BEGIN takes the write lock up
 * front, so a second writer waits on the busy timeout instead.
 *
 * A transaction asked for `read only` opens deferred: in WAL mode it reads one
 * snapshot and never contends with a writer.
 */

const NO_STREAMING = 'the SQLite dialect does not support streaming queries';

class SqliteConnection implements DatabaseConnection {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const statement = this.database.prepare<R, SQLQueryBindings[]>(compiled.sql);
    try {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Kysely's compiled parameters are the values the query builder bound, all of SQLite's bindable kinds.
      const parameters = compiled.parameters as SQLQueryBindings[];
      // A statement that yields columns — a select, a `RETURNING`, a pragma —
      // is read; anything else is run for its change count.
      if (statement.columnNames.length > 0) {
        return Promise.resolve({ rows: statement.all(...parameters) });
      }
      const { changes } = statement.run(...parameters);
      return Promise.resolve({ numAffectedRows: BigInt(changes), rows: [] });
    } finally {
      statement.finalize();
    }
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error(NO_STREAMING);
  }
}

/**
 * Set while a transaction's own callback runs. SQLite is ONE connection per
 * handle, so a query on the handle from inside that callback waits for a
 * connection the callback itself holds — forever. The driver refuses it
 * instead (see {@link holdingConnection}).
 */
const held = new AsyncLocalStorage<true>();

/**
 * Run `fn` as the body of an open transaction: any query that asks the handle
 * for a connection from inside it is refused rather than left to deadlock.
 */
export function holdingConnection<T>(fn: () => Promise<T>): Promise<T> {
  return held.run(true, fn);
}

/**
 * The one connection, behind a mutex. Every query outside a transaction, and
 * every transaction whole, takes it in turn — which is also what serializes
 * writers inside one process before the database lock serializes them across
 * processes.
 */
class SqliteDriver implements Driver {
  private readonly connection: SqliteConnection;
  private readonly database: Database;
  private queue: Promise<void> = Promise.resolve();
  private release: (() => void) | undefined;

  constructor(database: Database) {
    this.connection = new SqliteConnection(database);
    this.database = database;
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (held.getStore() === true) {
      throw invariant(
        'a query asked the SQLite store for a connection inside an open transaction',
        'read through the transaction (StoreWriter), never through a Store facet, inside transact',
      );
    }
    // Queue behind whoever holds the connection or waits for it, and leave a
    // turn of our own for the next caller to wait on.
    const previous = this.queue;
    const turn = Promise.withResolvers<void>();
    this.queue = turn.promise;
    await previous;
    this.release = turn.resolve;
    return this.connection;
  }

  releaseConnection(): Promise<void> {
    const release = this.release;
    this.release = undefined;
    release?.();
    return Promise.resolve();
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    const begin = settings.accessMode === 'read only' ? 'begin deferred' : 'begin immediate';
    await connection.executeQuery(CompiledQuery.raw(begin));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }

  init(): Promise<void> {
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    this.database.close();
    return Promise.resolve();
  }
}

/**
 * Kysely's SQLite adapter, minus Kysely's own connection mutex. Kysely queues a
 * single-connection dialect's callers BEFORE it reaches the driver, so a query
 * that would deadlock waits in that queue where the driver cannot see it to
 * refuse it. The driver above keeps the one queue itself, behind the check.
 */
class OwnMutexSqliteAdapter extends SqliteAdapter {
  override get supportsMultipleConnections(): boolean {
    return true;
  }
}

/** A Kysely {@link Dialect} over an open `bun:sqlite` database. */
export function createBunSqliteDialect(database: Database): Dialect {
  return {
    createAdapter: (): DialectAdapter => new OwnMutexSqliteAdapter(),
    createDriver: () => new SqliteDriver(database),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  };
}
