import type { Store } from '../core';
import { deriveSet, findNodeInSet, resolveProjectKeyInSet } from '../core';
import type { ArtifactStore } from '../core/artifacts/store';
import type { SeedStore } from '../core/seeds/store';
import type { NodePatch } from '../core/store';
import { sqliteDialect } from '../core/store-sqlite/index';
import { createSqliteTestStore } from '../core/store-sqlite/testing';
import { now } from '../core/time';
import type { DoctorBackend } from '../doctor/contract';
import { createSqlDoctorBackend } from '../doctor/sql/backend';

/**
 * The test substrate: a fresh, migrated SQLite {@link Store} in memory (ADR
 * 0032), with the seed and artifact facets and the doctor over the same handle.
 * Mirrors `BuiltStore` — `close()` releases the database. In-process and
 * binary-free, so no suite skips for want of a store.
 */
export type TestStore = {
  store: Store;
  /** The store's seed facet — seed-mutation fixtures drive it directly. */
  seeds: SeedStore;
  /** The store's artifact facet — artifact-mutation fixtures drive it directly. */
  artifacts: ArtifactStore;
  /** The SQL doctor over this store. */
  doctor: DoctorBackend;
  close: () => Promise<void>;
};

export async function createTestStore(): Promise<TestStore> {
  const test_ = await createSqliteTestStore();
  return {
    artifacts: test_.store.artifacts,
    close: test_.close,
    doctor: createSqlDoctorBackend(test_.db, sqliteDialect),
    seeds: test_.store.seeds,
    store: test_.store,
  };
}

/**
 * Resolve a project's canonical key from a fresh working set.
 */
export async function projectIdOf(store: Store, key: string): Promise<string> {
  return resolveProjectKeyInSet(deriveSet(await store.loadWorkingSet()), key);
}

/** Resolve a node's canonical `KEY-seq` stem from a fresh working set. */
export async function nodeIdOf(store: Store, ref: string): Promise<string> {
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), ref);
  if (node === undefined) {
    throw new Error(`no node ${ref}`);
  }
  return node.id;
}

/**
 * Raw node patch behind the verbs — for fixtures that force a lifecycle/hold/
 * open_ended state the verbs would gate. Co-writes the `updated_at` stamp the
 * write path's co-write invariant requires (MMR-303): a raw patch of a
 * default-omitted field is an unguarded add on its own, and the writer refuses
 * a guard-less plan. Caller fields win, so an explicit `updated_at` (e.g. a
 * stale-test backdate) overrides the stamp.
 */
export async function rawPatchNode(store: Store, id: string, fields: NodePatch): Promise<void> {
  await store.transact((w) => w.updateNode(id, { updated_at: now(), ...fields }));
}

/**
 * Raw dependency edge behind the verbs — no cycle guard, so corruption and
 * legacy-data fixtures can write shapes `depend` refuses. Stamps the dependent
 * node exactly as the real verb does (MMR-303): a first edge is an unguarded
 * `depends_on` add on its own.
 */
export async function rawDep(store: Store, nodeId: string, dependsOnId: string): Promise<void> {
  await store.transact(async (w) => {
    await w.insertDependency({ depends_on_node_id: dependsOnId, node_id: nodeId });
    await w.updateNode(nodeId, { updated_at: now() });
  });
}

/**
 * A {@link Store} that must never be called (MMR-271): every property read
 * throws. For a suite whose routes never touch storage (asset serving, the
 * port hunt's non-request paths) — a real store must open a database just to
 * construct the fixture; this needs nothing, so those tests run cheaply.
 * A read that *does* reach it fails loudly rather than silently misbehaving,
 * so an accidental new store call surfaces as a clear assertion failure
 * instead of a green test over the wrong data.
 */
export function inertStore(): Store {
  // The Proxy target is never actually read — every trap throws before the
  // empty object underneath is consulted — so asserting it to the full
  // interface here is safe despite looking narrower than `{}`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return new Proxy<Store>({} as unknown as Store, {
    get(_target, prop) {
      // Symbol reads (e.g. util.inspect's custom hook, `then`) are
      // introspection, not a store call — stay silent so a failing
      // assertion's own error formatting never gets clobbered by this one.
      if (typeof prop === 'symbol') {
        return undefined;
      }
      throw new Error(`inert test store: unexpected read of store.${prop}`);
    },
  });
}
