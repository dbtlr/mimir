import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openPostgres, upgradeSchema } from './core/store-postgres/index';
import { createThrowawaySchema } from './core/store-postgres/testing';
import { bunExec } from './exec';
import { configPath } from './service/config';
import { buildStore } from './store-backend';
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

// The per-install backend fence (ADR 0030 Decision 1). A Postgres install needs
// a connection URL: the fence alone names no database, and falling back to the
// vault would silently open the wrong store.
test('the postgres backend refuses without [store] url', async () => {
  let threw = false;
  try {
    await buildStore({}, { serve: {}, store: { backend: 'postgres' }, vault: {} });
  } catch (error) {
    threw = true;
    const message = (error as Error).message;
    expect(message).toContain('[store] url');
    expect(message).toContain(configPath());
    expect(message).toContain('docs/guides/postgres-store.md');
  }
  expect(threw).toBe(true);
});

/**
 * The schema gate at the composition root (ADR 0030 Decision 5). Needs a real
 * server, because the point is a database a previous run never touched: PGlite
 * would be a fresh store either way, and the gate's whole job is to tell a
 * fresh store from one an older binary already wrote.
 */
const POSTGRES_URL = process.env.MIMIR_TEST_POSTGRES_URL;

test.skipIf(POSTGRES_URL === undefined)(
  'a postgres build refuses an unmigrated store, then builds once store upgrade has run',
  async () => {
    const schema = await createThrowawaySchema(POSTGRES_URL ?? '');
    const config = {
      serve: {},
      store: { backend: 'postgres' as const, url: schema.url },
      vault: {},
    };
    try {
      let refusal = '';
      try {
        await buildStore({}, config);
      } catch (error) {
        refusal = (error as Error).message;
      }
      expect(refusal).toContain('the Postgres store has no schema');

      const handle = openPostgres(schema.url);
      try {
        await upgradeSchema(handle.db);
      } finally {
        await handle.close();
      }

      const built = await buildStore({}, config);
      try {
        expect((await built.store.loadWorkingSet()).nodes).toEqual([]);
        // The backend supplies its own doctor facet, and it carries no repair.
        expect((await built.doctor.diagnose(undefined)).findings).toEqual([]);
        expect(built.doctor.repair).toBeUndefined();
      } finally {
        await built.close();
      }
    } finally {
      await schema.drop();
    }
  },
);

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
  for (const [problem, remedy] of [
    ['invalid-backend', 'set backend to one of: norn, postgres'],
    ['malformed', 'set backend to one of: norn, postgres'],
    // A bad url is a different fault and gets a different remedy: re-reading
    // the list of backends does not fix a connection string.
    ['invalid-url', 'set url to a Postgres connection URL'],
  ] as const) {
    let threw = false;
    try {
      await buildStore({}, { serve: {}, store: { problem }, vault: {} });
    } catch (error) {
      threw = true;
      expect((error as Error).message).toContain(`[store] is unusable (${problem})`);
      expect((error as Error).message).toContain(remedy);
      expect((error as Error).message).toContain(configPath());
    }
    expect(threw).toBe(true);
  }
});
