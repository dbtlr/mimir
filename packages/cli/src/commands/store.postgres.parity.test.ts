import { afterAll, beforeAll, expect, test } from 'bun:test';

import { SCHEMA_VERSION, upgradeSchema } from '@mimir/core';
import type { GlobalConfig, PostgresHandle } from '@mimir/core';
import { createEmptyPostgresDb } from '@mimir/core/testing';

import { parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { pinText, registerParity, runNew } from '../testing/parity';
import type { ParityCase } from '../testing/parity';
import { runArgv } from '../testing/run';

/**
 * `store upgrade` on a Postgres install, over an in-process PGlite database.
 * Each CLI gets its own fresh database in the same starting state, so the
 * second run is not "already current" because the first one migrated.
 */
type Start = 'empty' | 'current' | 'newer';
type PgCase = ParityCase & { config: GlobalConfig; start?: Start };

const URL = 'postgres://localhost/mimir';
const POSTGRES: GlobalConfig = { store: { backend: 'postgres', url: URL } };

/** The database the next `openPostgres` hands out, and the config `readConfig` reports. */
const state: { db?: PostgresHandle['db']; config: GlobalConfig } = { config: { store: {} } };

let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard({
    openPostgres: (): PostgresHandle => {
      const { db } = state;
      if (db === undefined) {
        throw new Error('the case opened Postgres without a database');
      }
      // The command closes what it opens; the case destroys the database itself.
      return { close: () => Promise.resolve(), db };
    },
    readConfig: () => state.config,
  });
});
afterAll(async () => {
  await board.close();
});

/** A fresh PGlite database in the case's starting state. */
async function freshDatabase(start: Start) {
  const { close, db } = await createEmptyPostgresDb();
  if (start !== 'empty') {
    await upgradeSchema(db);
  }
  if (start === 'newer') {
    await db
      .insertInto('schema_version')
      .values({ applied_at: new Date().toISOString(), version: SCHEMA_VERSION + 1 })
      .execute();
  }
  return { close, db };
}

const upgrade = (
  name: string,
  config: GlobalConfig,
  start: Start = 'empty',
  options: ParityCase['options'] = {},
): PgCase => ({ config, name, options, path: ['store', 'upgrade'], start });

const CASES: PgCase[] = [
  upgrade('store upgrade (postgres, fresh)', POSTGRES),
  upgrade('store upgrade (postgres, fresh) -f records', POSTGRES, 'empty', { format: 'records' }),
  upgrade('store upgrade (postgres, fresh) -f json', POSTGRES, 'empty', { format: 'json' }),
  upgrade('store upgrade (postgres, current)', POSTGRES, 'current'),
  upgrade('store upgrade (postgres, current) -f records', POSTGRES, 'current', {
    format: 'records',
  }),
  upgrade('store upgrade (postgres, current) -f json', POSTGRES, 'current', { format: 'json' }),
  upgrade('store upgrade (postgres, newer schema)', POSTGRES, 'newer'),
  upgrade('store upgrade (postgres, newer schema) -f json', POSTGRES, 'newer', { format: 'json' }),
  upgrade('store upgrade (unusable config)', { store: { problem: 'invalid-backend' } }),
  upgrade(
    'store upgrade (unusable config) -f json',
    { store: { problem: 'invalid-backend' } },
    'empty',
    {
      format: 'json',
    },
  ),
  upgrade('store upgrade (removed backend)', { store: { problem: 'removed-backend' } }),
];

// Each case gets its own database, so one shared board fits; no records are written.
registerParity(import.meta.url, CASES, async (c) => {
  state.config = c.config;
  const fresh = await freshDatabase(c.start ?? 'empty');
  state.db = fresh.db;
  try {
    const run = await runNew((argv) => board.app(undefined, argv), c);
    // The unusable-config message names the checkout's own config file.
    return pinText(run, board.dir).replaceAll(/\S*\.dev\/config\/mimir\/config\.toml/g, '<config>');
  } finally {
    await fresh.close();
  }
});

// The missing URL is a plain Error in core, not a renderable one: it escapes to the entry
// point, so the case pins the message rather than a failure shape.
test('store upgrade on postgres with no url fails with the missing-url message', async () => {
  state.config = { store: { backend: 'postgres' } };
  const now = await runArgv(board.app(), ['store', 'upgrade']);
  expect(now.exitCode).toBe(1);
  expect(now.stderr).toContain('[store] backend = "postgres" needs [store] url in ');
  expect(now.stderr).toContain('the Postgres connection URL. See docs/guides/postgres-store.md');
});
