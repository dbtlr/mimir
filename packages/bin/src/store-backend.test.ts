import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bunExec } from './exec';
import { configPath } from './service/config';
import { buildStore, POSTGRES_BACKEND_UNAVAILABLE } from './store-backend';
import { converge } from './vault/converge';

/**
 * The store composition root (ADR 0030): `[store] backend` fences which backend
 * an install runs on, and the built store exposes that backend's doctor facet
 * rather than any backend-typed member. The Norn arm resolves + converges the
 * vault and attaches the client, so it needs a real `norn` binary; those cases
 * are skipped when it is off PATH (CI). The fence cases need no binary.
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
    // The backend supplies its own doctor facet (ADR 0030 Decision 6).
    expect((await built.doctor.diagnose(undefined)).findings).toEqual([]);
    // A default (read-only) build carries no repair capability.
    expect(built.doctor.repair).toBeUndefined();
  } finally {
    await built.close();
  }
});

test.skipIf(!NORN)('a CLI build wires the doctor repair capability', async () => {
  await converge(dir, { allowCreate: true, exec: bunExec });
  process.env.MIMIR_VAULT = dir;

  const built = await buildStore({ repair: true });
  try {
    expect(built.doctor.repair).toBeDefined();
  } finally {
    await built.close();
  }
});

// The per-install backend fence (ADR 0030 Decision 1, MMR-378). `postgres` is
// declared but unimplemented until MMR-379: it must refuse by name, never fall
// back to the vault, so an operator who sets the fence early is not silently
// left on the other store.
test('buildStore refuses the postgres backend by name until MMR-379 lands', async () => {
  let threw = false;
  try {
    await buildStore({}, { serve: {}, store: { backend: 'postgres' }, vault: {} });
  } catch (error) {
    threw = true;
    expect((error as Error).message).toBe(POSTGRES_BACKEND_UNAVAILABLE);
  }
  expect(threw).toBe(true);
});

test.skipIf(!NORN)('an absent or explicit norn fence both build the Norn backend', async () => {
  await converge(dir, { allowCreate: true, exec: bunExec });
  process.env.MIMIR_VAULT = dir;

  for (const store of [{}, { backend: 'norn' as const }]) {
    const built = await buildStore({}, { serve: {}, store, vault: {} });
    try {
      expect((await built.store.loadWorkingSet()).nodes).toEqual([]);
    } finally {
      await built.close();
    }
  }
});

test('an unusable [store] section is fatal, never a fallback to norn', async () => {
  // The fence selects which store gets WRITTEN: a typo in a Postgres install
  // must not converge and write a local vault instead.
  for (const problem of ['invalid-backend', 'malformed'] as const) {
    let threw = false;
    try {
      await buildStore({}, { serve: {}, store: { problem }, vault: {} });
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain(`[store] is unusable (${problem})`);
      expect((error as Error).message).toContain('set backend to one of: norn, postgres');
      expect((error as Error).message).toContain(configPath());
    }
    expect(threw).toBe(true);
  }
});
