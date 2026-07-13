import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Store } from '../core';
import { deriveSet, findNodeInSet, resolveProjectKeyInSet } from '../core';
import { bunExec } from '../exec';
import { NornClient } from '../norn/client';
import { createNornWriteStore } from '../norn/writer';
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
export type TestStore = { store: Store; close: () => Promise<void> };

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
      store: createNornWriteStore(client, root),
    };
  } catch (error) {
    // A failed converge (or client construction) must not strand the temp dir.
    rmSync(root, { force: true, recursive: true });
    throw error;
  }
}

/**
 * Resolve a project's surrogate id from a fresh working set by its `KEY`. Over
 * the Norn store the numeric id is a per-snapshot artifact (a create returns
 * `id: -1` for projects), so a chained create/mutation resolves the current id
 * by identity rather than reusing a stale one — the same thing every CLI command
 * does across process boundaries.
 */
export async function projectIdOf(store: Store, key: string): Promise<number> {
  return resolveProjectKeyInSet(deriveSet(await store.loadWorkingSet()), key);
}

/** Resolve a node's surrogate id from a fresh working set by its `KEY-seq` stem. */
export async function nodeIdOf(store: Store, ref: string): Promise<number> {
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), ref);
  if (node === undefined) {
    throw new Error(`no node ${ref}`);
  }
  return node.id;
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
