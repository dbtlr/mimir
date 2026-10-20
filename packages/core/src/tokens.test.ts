import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import { createProject } from './create';
import { postgresDialect } from './store-postgres/dialect';
import { createPgliteTestStore } from './store-postgres/testing';
import { sqliteDialect } from './store-sqlite/dialect';
import { createSqliteTestStore } from './store-sqlite/testing';
import { refusalOf } from './testing/conformance';
import { createTokenStore, normalizePairingCode } from './tokens';

describe.each([
  { dialect: sqliteDialect, name: 'SQLite', open: createSqliteTestStore },
  { dialect: postgresDialect, name: 'Postgres', open: createPgliteTestStore },
])('$name host tokens', ({ name, open, dialect }) => {
  const closes: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closes.splice(0)) {
      await close();
    }
  });
  async function fixture(clock?: () => string) {
    const handle = await open();
    closes.push(handle.close);
    let time = new Date('2026-10-20T12:00:00.000Z');
    const tokens = createTokenStore({
      clock: clock ?? (() => time.toISOString()),
      db: handle.db,
      dialect,
    });
    return {
      ...handle,
      advance: (ms: number) => {
        time = new Date(time.getTime() + ms);
      },
      tokens,
    };
  }

  test('replaces a pending code and consumes the replacement once', async () => {
    const { db, tokens } = await fixture();
    const oldCode = await tokens.issueCode('laptop');
    const code = await tokens.issueCode('laptop');
    expect(await tokens.redeem(oldCode)).toBeNull();
    const redeemed = await tokens.redeem(`${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase());
    expect(redeemed?.device).toBe('laptop');
    expect(redeemed?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await tokens.redeem(code)).toBeNull();
    expect(await db.selectFrom('pairing_codes').selectAll().execute()).toEqual([]);
    const row = await db.selectFrom('device_tokens').selectAll().executeTakeFirstOrThrow();
    expect(row.token_hash).toBe(
      createHash('sha256')
        .update(redeemed?.token ?? '')
        .digest('hex'),
    );
    expect(row.user).toBe('owner');
    expect(row.last_used_at).toBeNull();
    expect(row.revoked_at).toBeNull();
  });

  test('expiry refuses a code at the ten-minute boundary without rotating a token', async () => {
    const { tokens, advance } = await fixture();
    const first = await tokens.redeem(await tokens.issueCode('laptop'));
    const code = await tokens.issueCode('laptop');
    advance(10 * 60 * 1000);
    expect(await tokens.redeem(code)).toBeNull();
    expect(await tokens.redeem('unknown!')).toBeNull();
    expect(await tokens.verify(first?.token ?? '')).toBe('laptop');
  });

  test('verifies, rotates and revokes tokens while retaining history without hashes in listings', async () => {
    const { tokens, advance } = await fixture();
    const first = await tokens.redeem(await tokens.issueCode('laptop'));
    expect(first).not.toBeNull();
    expect(await tokens.verify(first?.token ?? '')).toBe('laptop');
    expect(await tokens.verify('unknown')).toBeNull();
    advance(1000);
    const second = await tokens.redeem(await tokens.issueCode('laptop'));
    expect(await tokens.verify(first?.token ?? '')).toBeNull();
    expect(await tokens.verify(second?.token ?? '')).toBe('laptop');
    expect(await tokens.list()).toEqual([
      {
        created_at: '2026-10-20T12:00:01.000Z',
        device: 'laptop',
        id: expect.any(String),
        last_used_at: '2026-10-20T12:00:01.000Z',
        revoked_at: null,
        user: 'owner',
      },
    ]);
    expect(await tokens.list({ all: true })).toHaveLength(2);
    await tokens.revoke('laptop');
    await tokens.revoke('missing');
    expect(await tokens.verify(second?.token ?? '')).toBeNull();
    expect(await tokens.list()).toEqual([]);
    expect((await tokens.list({ all: true })).map((row) => row.revoked_at)).toEqual([
      '2026-10-20T12:00:01.000Z',
      '2026-10-20T12:00:01.000Z',
    ]);
  });

  test('updates last_used only after more than five minutes, starting with first use', async () => {
    const { tokens, advance } = await fixture();
    const redeemed = await tokens.redeem(await tokens.issueCode('laptop'));
    const token = redeemed?.token ?? '';
    expect((await tokens.list()).at(0)?.last_used_at).toBeNull();
    expect(await tokens.verify(token)).toBe('laptop');
    advance(5 * 60 * 1000);
    expect(await tokens.verify(token)).toBe('laptop');
    expect((await tokens.list()).at(0)?.last_used_at).toBe('2026-10-20T12:00:00.000Z');
    advance(1);
    expect(await tokens.verify(token)).toBe('laptop');
    expect((await tokens.list()).at(0)?.last_used_at).toBe('2026-10-20T12:05:00.001Z');
  });

  test('throttles parseable clocks at exactly five minutes and updates one millisecond later', async () => {
    let instant = '2026-10-20T12:00:00Z';
    const { tokens } = await fixture(() => instant);
    const paired = await tokens.redeem(await tokens.issueCode('laptop'));
    const token = paired?.token ?? '';
    expect(await tokens.verify(token)).toBe('laptop');
    const firstUse = (await tokens.list()).at(0)?.last_used_at;
    instant = '2026-10-20T12:05:00Z';
    expect(await tokens.verify(token)).toBe('laptop');
    expect((await tokens.list()).at(0)?.last_used_at).toBe(firstUse);
    instant = '2026-10-20T12:05:00.001Z';
    expect(await tokens.verify(token)).toBe('laptop');
    expect((await tokens.list()).at(0)?.last_used_at).toBe('2026-10-20T12:05:00.001Z');
  });

  test('compares previously persisted noncanonical usage timestamps by instant', async () => {
    let instant = '2026-10-20T12:00:00.000Z';
    const { db, tokens } = await fixture(() => instant);
    const paired = await tokens.redeem(await tokens.issueCode('laptop'));
    // A token written by the original injectable-clock implementation.
    await db.updateTable('device_tokens').set({ last_used_at: '2026-10-20T12:00:00Z' }).execute();
    instant = '2026-10-20T12:05:00Z';
    expect(await tokens.verify(paired?.token ?? '')).toBe('laptop');
    expect((await tokens.list()).at(0)?.last_used_at).toBe('2026-10-20T12:00:00Z');
    instant = '2026-10-20T12:05:00.001Z';
    expect(await tokens.verify(paired?.token ?? '')).toBe('laptop');
    expect((await tokens.list()).at(0)?.last_used_at).toBe('2026-10-20T12:05:00.001Z');
  });

  test('persists canonical instants for parseable clocks throughout the credential lifecycle', async () => {
    let instant = '2026-10-20T12:00:00+00:00';
    const { db, tokens } = await fixture(() => instant);
    const code = await tokens.issueCode('laptop');
    const pending = await db.selectFrom('pairing_codes').selectAll().executeTakeFirstOrThrow();
    expect(pending.created_at).toBe('2026-10-20T12:00:00.000Z');
    expect(pending.expires_at).toBe('2026-10-20T12:10:00.000Z');
    const first = await tokens.redeem(code);
    expect(await tokens.verify(first?.token ?? '')).toBe('laptop');
    expect((await tokens.list()).at(0)).toMatchObject({
      created_at: '2026-10-20T12:00:00.000Z',
      last_used_at: '2026-10-20T12:00:00.000Z',
    });
    instant = '2026-10-20T08:00:01-04:00';
    await tokens.redeem(await tokens.issueCode('laptop'));
    expect((await tokens.list({ all: true })).at(0)?.revoked_at).toBe('2026-10-20T12:00:01.000Z');
    expect((await tokens.list()).at(0)?.created_at).toBe('2026-10-20T12:00:01.000Z');
    instant = '2026-10-20T12:00:02Z';
    await tokens.revoke('laptop');
    expect((await tokens.list({ all: true })).at(1)?.revoked_at).toBe('2026-10-20T12:00:02.000Z');
  });

  test.each([
    {
      accepted: true,
      issued: '2026-10-20T12:00:00.500Z',
      label: '500ms before expiry, no milliseconds',
      redeemed: '2026-10-20T12:10:00Z',
    },
    {
      accepted: false,
      issued: '2026-10-20T12:00:00Z',
      label: 'exact expiry, no milliseconds',
      redeemed: '2026-10-20T12:10:00Z',
    },
    {
      accepted: false,
      issued: '2026-10-20T12:00:00+00:00',
      label: 'exact expiry, UTC offset without milliseconds',
      redeemed: '2026-10-20T12:10:00+00:00',
    },
    {
      accepted: false,
      issued: '2026-10-20T12:00:00Z',
      label: 'one millisecond after expiry',
      redeemed: '2026-10-20T12:10:00.001Z',
    },
  ])('compares pairing expiry by instant: $label', async ({ accepted, issued, redeemed }) => {
    let instant: string = issued;
    const { tokens } = await fixture(() => instant);
    const code = await tokens.issueCode('laptop');
    instant = redeemed;
    const result = await tokens.redeem(code);
    expect(result?.device ?? null).toBe(accepted ? 'laptop' : null);
  });

  test('exports work state without credentials and imports without replacing local credentials', async () => {
    const source = await fixture();
    await createProject(source.store, { key: 'DEMO', name: 'Demo' });
    const sourceToken = await source.tokens.redeem(await source.tokens.issueCode('source'));
    await source.tokens.issueCode('pending-source');
    const document = await source.store.export();
    expect(Object.keys(document).toSorted()).toEqual([
      'annotations',
      'artifacts',
      'bodySections',
      'edges',
      'exported_at',
      'nodes',
      'projects',
      'schema_version',
      'scratchpads',
      'seeds',
      'tags',
      'transitions',
    ]);
    const target = await fixture();
    const targetToken = await target.tokens.redeem(await target.tokens.issueCode('local'));
    const pending = await target.tokens.issueCode('pending-local');
    const before = await target.tokens.list({ all: true });
    const enriched = {
      ...document,
      device_tokens: await source.db.selectFrom('device_tokens').selectAll().execute(),
      pairing_codes: await source.db.selectFrom('pairing_codes').selectAll().execute(),
    };
    await target.store.import(enriched, { dryRun: true, mode: 'fresh' });
    await target.store.import(enriched, { dryRun: false, mode: 'fresh' });
    await target.store.import(enriched, { dryRun: false, mode: 'resume' });
    expect(await target.tokens.list({ all: true })).toEqual(before);
    expect(await target.tokens.verify(sourceToken?.token ?? '')).toBeNull();
    expect(await target.tokens.verify(targetToken?.token ?? '')).toBe('local');
    expect((await target.tokens.redeem(pending))?.device).toBe('pending-local');
    expect((await target.store.export()).projects).toEqual(document.projects);
    const fresh = await fixture();
    await fresh.store.import(document, { dryRun: false, mode: 'fresh' });
    expect(await fresh.tokens.list({ all: true })).toEqual([]);
    expect(await fresh.db.selectFrom('pairing_codes').selectAll().execute()).toEqual([]);
  });

  test('accepts Crockford confusables when redeeming and refuses other syntax', async () => {
    const { db, tokens } = await fixture();
    await db
      .insertInto('pairing_codes')
      .values({
        code_hash: createHash('sha256').update('0101ABCD').digest('hex'),
        created_at: '2026-10-20T12:00:00.000Z',
        device: 'confusable',
        expires_at: '2026-10-20T12:10:00.000Z',
      })
      .execute();
    expect((await tokens.redeem('oIoL-abcd'))?.device).toBe('confusable');
  });

  test('enforces one active token per device and unique hashes even for revoked tokens', async () => {
    const { db, tokens } = await fixture();
    await tokens.redeem(await tokens.issueCode('laptop'));
    const row = await db.selectFrom('device_tokens').selectAll().executeTakeFirstOrThrow();
    expect(
      await refusalOf(
        db
          .insertInto('device_tokens')
          .values({ ...row, id: 'second', token_hash: 'another-hash' })
          .execute(),
      ),
    ).toContain('constraint');
    await tokens.revoke('laptop');
    await db
      .insertInto('device_tokens')
      .values({ ...row, id: 'second', token_hash: 'another-hash' })
      .execute();
    expect(
      await refusalOf(
        db
          .insertInto('device_tokens')
          .values({ ...row, device: 'other', id: 'third', revoked_at: row.created_at })
          .execute(),
      ),
    ).toContain('constraint');
    expect(await tokens.list()).toHaveLength(1);
  });

  test('rolls back code consumption and prior revocation if the new token cannot be stored', async () => {
    const { db, tokens } = await fixture();
    const prior = await tokens.redeem(await tokens.issueCode('laptop'));
    const code = await tokens.issueCode('laptop');
    const rejectInsert =
      name === 'SQLite'
        ? `CREATE TRIGGER reject_token BEFORE INSERT ON device_tokens BEGIN SELECT RAISE(ABORT, 'injected token storage failure'); END`
        : `CREATE FUNCTION reject_token() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected token storage failure'; END $$`;
    await sql.raw(rejectInsert).execute(db);
    if (name === 'Postgres') {
      await sql
        .raw(
          'CREATE TRIGGER reject_token BEFORE INSERT ON device_tokens FOR EACH ROW EXECUTE FUNCTION reject_token()',
        )
        .execute(db);
    }
    expect(await refusalOf(tokens.redeem(code))).toContain('injected token storage failure');
    expect(await tokens.verify(prior?.token ?? '')).toBe('laptop');
    if (name === 'SQLite') {
      await sql.raw('DROP TRIGGER reject_token').execute(db);
    } else {
      await sql.raw('DROP TRIGGER reject_token ON device_tokens').execute(db);
    }
    expect((await tokens.redeem(code))?.device).toBe('laptop');
    expect(await tokens.verify(prior?.token ?? '')).toBeNull();
  });

  test('refuses a token revoked between the first read and the usage write transaction', async () => {
    const { db, tokens } = await fixture();
    const redeemed = await tokens.redeem(await tokens.issueCode('laptop'));
    const raced = createTokenStore({
      db,
      dialect: {
        ...dialect,
        write: async (database, action) => {
          await tokens.revoke('laptop');
          return dialect.write(database, action);
        },
      },
    });
    expect(await raced.verify(redeemed?.token ?? '')).toBeNull();
    expect((await tokens.list({ all: true })).at(0)?.last_used_at).toBeNull();
  });

  test('issues eight Crockford characters, hashed at rest, with a ten-minute TTL', async () => {
    const { db, tokens } = await fixture();
    const code = await tokens.issueCode('laptop');
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(await db.selectFrom('pairing_codes').selectAll().execute()).toEqual([
      {
        code_hash: createHash('sha256').update(code).digest('hex'),
        created_at: '2026-10-20T12:00:00.000Z',
        device: 'laptop',
        expires_at: '2026-10-20T12:10:00.000Z',
      },
    ]);
  });
});

test('normalizes only the eight-character code with an optional middle hyphen', () => {
  expect(normalizePairingCode('oIlL-abcd')).toBe('0111ABCD');
  expect(normalizePairingCode('oIolabcd')).toBe('0101ABCD');
  for (const input of [
    '',
    'ABCD-EFGU',
    'ABC-DEF12',
    ' ABCDEFGH',
    'ABCD--EFGH',
    'ABCDEFGH ',
    'ABßDEFG',
    'ABıDEFGH',
    'ABﬀDEFG',
  ]) {
    expect(normalizePairingCode(input)).toBeNull();
  }
});
