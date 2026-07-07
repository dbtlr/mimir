import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSqliteStore } from './core';
import { createProject } from './core/create';
import { createTestDb } from './db/testing';
import { bunExec } from './exec';
import type { GlobalConfig } from './service/config';
import { buildStore, storeBackend } from './store-backend';
import { backfillVaultData } from './vault/backfill';
import { converge } from './vault/converge';

/**
 * The store composition root (MMR-235): a single `[store] backend` selects the
 * WHOLE work-state store. These prove the resolution precedence and that each
 * branch of `buildStore` returns the store it claims — the sqlite default stays
 * put (behavior-neutral) and the Norn branch reads the vault, not the db.
 */

const NORN = Bun.which('norn') !== null;

const config = (store: GlobalConfig['store']): GlobalConfig => ({ serve: {}, store, vault: {} });

test('storeBackend resolves env over config over the sqlite default', () => {
  const prev = process.env.MIMIR_STORE_BACKEND;
  try {
    delete process.env.MIMIR_STORE_BACKEND;
    expect(storeBackend(config({}))).toBe('sqlite'); // built-in default
    expect(storeBackend(config({ backend: 'norn' }))).toBe('norn'); // config
    process.env.MIMIR_STORE_BACKEND = 'sqlite';
    expect(storeBackend(config({ backend: 'norn' }))).toBe('sqlite'); // env wins over config
  } finally {
    if (prev === undefined) {
      delete process.env.MIMIR_STORE_BACKEND;
    } else {
      process.env.MIMIR_STORE_BACKEND = prev;
    }
  }
});

test('buildStore(sqlite) returns the SQLite store; no vault facets', async () => {
  const db = await createTestDb();
  const built = await buildStore(db, 'sqlite');
  expect((await built.store.loadWorkingSet()).nodes).toEqual([]);
  // the vault-only doctor facets are absent on SQLite (typed rows, no vault)
  expect(built.readNodeDocs).toBeUndefined();
  expect(built.readVaultGraph).toBeUndefined();
  await built.close();
});

test.skipIf(!NORN)(
  'buildStore(norn) returns the Norn store — reads the vault, not the db',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-backend-'));
    const prevVault = process.env.MIMIR_VAULT;
    try {
      process.env.MIMIR_VAULT = dir;
      await converge(dir, { allowCreate: true, exec: bunExec, migrateData: backfillVaultData });
      const db = await createTestDb();
      // Seed a project into the SQLite db: a db-backed store would surface it, so
      // an empty working set proves the node reads route through the (empty) vault.
      await createProject(createSqliteStore(db), { description: 'x', key: 'MMR', name: 'Mimir' });

      const built = await buildStore(db, 'norn');
      expect((await built.store.loadWorkingSet()).projects).toEqual([]); // vault, not db
      expect(built.readNodeDocs).toBeDefined(); // Norn-only vault facets present
      await built.close();
    } finally {
      if (prevVault === undefined) {
        delete process.env.MIMIR_VAULT;
      } else {
        process.env.MIMIR_VAULT = prevVault;
      }
      rmSync(dir, { force: true, recursive: true });
    }
  },
);
