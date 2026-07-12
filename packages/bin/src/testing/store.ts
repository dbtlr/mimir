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
  await converge(root, { allowCreate: true, exec: bunExec });
  const client = new NornClient({ vaultPath: root });
  return {
    close: async () => {
      await client.close();
      rmSync(root, { force: true, recursive: true });
    },
    store: createNornWriteStore(client, root),
  };
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
