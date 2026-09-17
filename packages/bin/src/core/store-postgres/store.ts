import type { Kysely } from 'kysely';

import type { Store } from '../store';
import { createPostgresArtifactStore } from './artifacts';
import { createPostgresBodySectionStore } from './body-sections';
import type { DB } from './schema';
import { createPostgresScratchpadStore } from './scratchpads';
import { createPostgresSeedStore } from './seeds';
import { exportPostgresStoreFrom, importPostgresStore } from './transfer';
import { createPostgresTransitionsFeed } from './transitions';
import { serializable, snapshotRead } from './tx';
import { loadNodesForProjects, loadProjects, loadWorkingSet } from './working-set';
import { createPostgresWriter } from './writer';

/**
 * The Postgres `Store` (ADR 0030) — the seam assembled over one Kysely handle.
 *
 * The bulk read runs in its own REPEATABLE READ transaction: `loadWorkingSet`
 * is several queries and the core derives over them as one projection, so a
 * concurrent write landing between them would hand the derivation a working set
 * no moment ever held.
 *
 * The caller must have passed the schema gate (`assertSchemaCurrent`) before
 * building this. That check belongs to the composition root, not here: it is a
 * once-per-process question, and a store that re-asked it per call would pay
 * for it on every read.
 */
export function createPostgresStore(db: Kysely<DB>): Store {
  return {
    artifacts: createPostgresArtifactStore(db),
    bodySections: createPostgresBodySectionStore(db),
    export: () => exportPostgresStoreFrom(db),
    import: (document, opts) => importPostgresStore(db, document, opts),
    loadNodesForProjects: (keys, valid) => loadNodesForProjects(db, keys, valid),
    loadProjects: () => loadProjects(db),
    loadWorkingSet: () => snapshotRead(db, (tx) => loadWorkingSet(tx)),
    scratchpads: createPostgresScratchpadStore(db),
    seeds: createPostgresSeedStore(db),
    transact: (fn) => serializable(db, (tx) => fn(createPostgresWriter(tx))),
    transitions: createPostgresTransitionsFeed(db),
  };
}
