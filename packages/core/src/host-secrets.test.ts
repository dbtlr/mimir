import { afterEach, describe, expect, test } from 'bun:test';

import { createProject } from './create';
import { createHostSecretStore } from './host-secrets';
import { postgresDialect } from './store-postgres/dialect';
import { createPgliteTestStore } from './store-postgres/testing';
import { sqliteDialect } from './store-sqlite/dialect';
import { createSqliteTestStore } from './store-sqlite/testing';

describe.each([
  { dialect: sqliteDialect, name: 'SQLite', open: createSqliteTestStore },
  { dialect: postgresDialect, name: 'Postgres', open: createPgliteTestStore },
])('$name host secrets', ({ dialect, open }) => {
  const closes: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closes.splice(0)) {
      await close();
    }
  });
  async function fixture() {
    const handle = await open();
    closes.push(handle.close);
    let time = new Date('2026-11-01T12:00:00.000Z');
    const secrets = createHostSecretStore({
      clock: () => time.toISOString(),
      db: handle.db,
      dialect,
    });
    return {
      ...handle,
      advance: (ms: number) => {
        time = new Date(time.getTime() + ms);
      },
      rows: () => handle.db.selectFrom('host_secrets').selectAll().orderBy('name').execute(),
      secrets,
    };
  }

  test('an unwritten name reads as absent', async () => {
    const { secrets } = await fixture();
    expect(await secrets.read('t3.oauth')).toBeUndefined();
  });

  test('a write inserts the sealed text with both stamps, and a rewrite replaces it and moves only updated_at', async () => {
    const { advance, rows, secrets } = await fixture();
    await secrets.write('t3.oauth', 'v1.first');
    expect(await secrets.read('t3.oauth')).toBe('v1.first');
    expect(await rows()).toEqual([
      {
        ciphertext: 'v1.first',
        created_at: '2026-11-01T12:00:00.000Z',
        name: 't3.oauth',
        updated_at: '2026-11-01T12:00:00.000Z',
      },
    ]);
    advance(60_000);
    await secrets.write('t3.oauth', 'v1.second');
    expect(await secrets.read('t3.oauth')).toBe('v1.second');
    expect(await rows()).toEqual([
      {
        ciphertext: 'v1.second',
        created_at: '2026-11-01T12:00:00.000Z',
        name: 't3.oauth',
        updated_at: '2026-11-01T12:01:00.000Z',
      },
    ]);
  });

  test('names are independent, and a write replaces only its own row', async () => {
    const { rows, secrets } = await fixture();
    await secrets.write('t3.oauth', 'v1.a');
    await secrets.write('other.token', 'v1.b');
    await secrets.write('t3.oauth', 'v1.c');
    expect(await secrets.read('t3.oauth')).toBe('v1.c');
    expect(await secrets.read('other.token')).toBe('v1.b');
    expect((await rows()).map((row) => row.name)).toEqual(['other.token', 't3.oauth']);
  });

  test('host secrets stay out of the transfer document, and an import leaves them intact', async () => {
    const source = await fixture();
    await createProject(source.store, { key: 'MMR', name: 'Mimir' });
    await source.secrets.write('t3.oauth', 'v1.source-only');
    const document = await source.store.export();
    expect(JSON.stringify(document)).not.toContain('t3.oauth');
    expect(JSON.stringify(document)).not.toContain('v1.source-only');
    expect(Object.keys(document)).not.toContain('host_secrets');

    const target = await fixture();
    await target.secrets.write('t3.oauth', 'v1.target');
    await target.store.import(document, { dryRun: false, mode: 'fresh' });
    expect(await target.secrets.read('t3.oauth')).toBe('v1.target');
    expect((await target.store.export()).projects.map((project) => project.key)).toEqual(['MMR']);
  });
});
