import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bunExec } from './exec';
import { buildStore } from './store-backend';
import { converge } from './vault/converge';

/**
 * The store composition root (MMR-234): the Norn vault is the sole backend, so
 * `buildStore` takes no backend argument — it resolves + converges the vault and
 * attaches the client. Needs a real `norn` binary; skipped when off PATH (CI).
 */
const NORN = Bun.which('norn') !== null;

let dir: string;
let prevVault: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-backend-'));
  prevVault = process.env.MIMIR_VAULT;
});
afterEach(() => {
  if (prevVault === undefined) {
    delete process.env.MIMIR_VAULT;
  } else {
    process.env.MIMIR_VAULT = prevVault;
  }
  rmSync(dir, { force: true, recursive: true });
});

test.skipIf(!NORN)('buildStore returns the Norn store over the resolved vault', async () => {
  // MIMIR_VAULT points at an already-converged vault, so buildStore adopts it.
  await converge(dir, { allowCreate: true, exec: bunExec });
  process.env.MIMIR_VAULT = dir;

  const built = await buildStore();
  try {
    // A fresh vault projects an empty working set — read through the vault.
    expect((await built.store.loadWorkingSet()).nodes).toEqual([]);
    // The vault diagnostics doctor consumes are always present now (Norn-only).
    expect(built.readDoctorSnapshot).toBeDefined();
  } finally {
    await built.close();
  }
});
