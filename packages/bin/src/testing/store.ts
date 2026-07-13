import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Store } from '../core';
import { deriveSet, findNodeInSet, resolveProjectKeyInSet } from '../core';
import type { DoctorDeps } from '../doctor/commands';
import { readDoctorSnapshot } from '../doctor/snapshot';
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
export type TestStore = {
  store: Store;
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
