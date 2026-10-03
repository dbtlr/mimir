import type { Kysely } from 'kysely';

import type { Store } from '../store';
import { createSqlArtifactStore } from './artifacts';
import { createSqlBodySectionStore } from './body-sections';
import type { StoreDialect } from './dialect';
import type { DB } from './schema';
import { createSqlScratchpadStore } from './scratchpads';
import { createSqlSeedStore } from './seeds';
import { exportSqlStoreFrom, importSqlStore } from './transfer';
import { createSqlTransitionsFeed } from './transitions';
import { loadNodesForProjects, loadProjects, loadWorkingSet } from './working-set';
import { createSqlWriter } from './writer';

/**
 * The shared SQL `Store` (ADR 0030, ADR 0032) — the seam assembled over one
 * Kysely handle and the dialect that handle speaks.
 *
 * The bulk read runs in its own snapshot transaction: `loadWorkingSet` is
 * several queries and the core derives over them as one projection, so a
 * concurrent write landing between them would hand the derivation a working set
 * no moment ever held.
 *
 * **A `Store`-level facet must never be called inside `transact`.** Each facet
 * here runs on the handle, not the transaction. On Postgres a facet call from
 * inside an open `transact` takes a SECOND pooled connection while the first
 * still holds the transaction: N concurrent writers doing it exhaust the pool
 * and deadlock, and the read that did get a connection sees COMMITTED state
 * rather than the transaction's own. SQLite has one connection, which the
 * transaction holds, so its driver refuses the call outright rather than wait
 * forever.
 * Anything a verb must read mid-transaction belongs on `StoreWriter`, which runs
 * on the transaction (MMR-379 — `readNextSection` is the case that found this).
 *
 * The caller must have passed the schema gate (`assertSchemaCurrent`) before
 * building this. That check belongs to the composition root, not here: it is a
 * once-per-process question, and a store that re-asked it per call would pay
 * for it on every read.
 */
export function createSqlStore(db: Kysely<DB>, dialect: StoreDialect): Store {
  return {
    artifacts: createSqlArtifactStore(db, dialect),
    bodySections: createSqlBodySectionStore(db, dialect),
    export: () => exportSqlStoreFrom(db, dialect),
    import: (document, opts) => importSqlStore(db, dialect, document, opts),
    loadNodesForProjects: (keys, valid) => loadNodesForProjects(db, dialect, keys, valid),
    loadProjects: () => loadProjects(db),
    loadWorkingSet: () => dialect.snapshot(db, (tx) => loadWorkingSet(tx, dialect)),
    scratchpads: createSqlScratchpadStore(db, dialect),
    seeds: createSqlSeedStore(db, dialect),
    transact: (fn) => dialect.write(db, (tx) => fn(createSqlWriter(tx, dialect))),
    transitions: createSqlTransitionsFeed(db),
  };
}
