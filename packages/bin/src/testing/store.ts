import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Store } from '../core';
import { deriveSet, findNodeInSet, resolveProjectKeyInSet } from '../core';
import type { SeedStore } from '../core/seeds/store';
import type { NodePatch } from '../core/store';
import { NornClient } from '../core/store-norn/client';
import { createNornSeedStore } from '../core/store-norn/seeds';
import { createNornWriteStore } from '../core/store-norn/writer';
import { now } from '../core/time';
import type { DoctorDeps } from '../doctor/commands';
import { readDoctorSnapshot } from '../doctor/snapshot';
import { bunExec } from '../exec';
import { converge } from '../vault/converge';

/**
 * The test substrate (MMR-234): a fresh Norn-backed {@link Store} over an
 * isolated temp vault. Mirrors `BuiltStore` — `close()` shuts the `norn mcp`
 * subprocess down and removes the temp vault.
 *
 * The `norn` subprocess is lazy (it spawns on the first store call, not here),
 * so construction is binary-free; a store *call* needs `norn` on PATH. Callers
 * gate their tests on `Bun.which('norn')` (skip when absent, as the norn-backed
 * suites already do) — a skipped test never runs its `beforeEach`, so the
 * temp-vault fixture stays cheap and CI (no norn) stays green.
 */
export type TestStore = {
  store: Store;
  /** The seed store over the same isolated Norn client — seed-mutation fixtures
   * (the MMR-313 co-write guard cycle) drive it directly, as the write `store`
   * has no seed surface. */
  seeds: SeedStore;
  close: () => Promise<void>;
  /** CLI-only repair dependencies over this isolated Norn client. */
  doctor: DoctorDeps;
  /** Deliberate hand-edit seam for corruption tests; path stays vault-relative. */
  corruptDocument: (path: string, mutate: (raw: string) => string) => void;
  /** Byte-exact observation seam for no-write/scope assertions. */
  readDocument: (path: string) => string;
  /** Deliberate missing-container corruption for recovery tests. */
  removeDocument: (path: string) => void;
};

function safeVaultPath(root: string, path: string): string {
  if (path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`test document path must stay vault-relative: ${path}`);
  }
  return join(root, path);
}

export async function createTestStore(): Promise<TestStore> {
  const root = mkdtempSync(join(tmpdir(), 'mimir-test-'));
  try {
    await converge(root, { allowCreate: true, exec: bunExec });
    const client = new NornClient({ vaultPath: root });
    return {
      close: async () => {
        try {
          await client.close();
        } finally {
          rmSync(root, { force: true, recursive: true });
        }
      },
      corruptDocument: (path, mutate) => {
        const absolute = safeVaultPath(root, path);
        writeFileSync(absolute, mutate(readFileSync(absolute, 'utf8')));
      },
      doctor: {
        readSnapshot: () => readDoctorSnapshot(client),
        repair: {
          applyPlan: (plan, confirm) => client.applyPlan(plan, confirm),
          vaultRoot: root,
        },
      },
      readDocument: (path) => readFileSync(safeVaultPath(root, path), 'utf8'),
      removeDocument: (path) => unlinkSync(safeVaultPath(root, path)),
      seeds: createNornSeedStore(client, root),
      store: createNornWriteStore(client, root),
    };
  } catch (error) {
    // A failed converge (or client construction) must not strand the temp dir.
    rmSync(root, { force: true, recursive: true });
    throw error;
  }
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
 * port hunt's non-request paths) — a real store needs `norn` on PATH just to
 * construct the fixture; this needs nothing, so those tests run everywhere.
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
