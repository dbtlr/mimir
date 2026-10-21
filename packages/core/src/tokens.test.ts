import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { sql } from 'kysely';

import { createProject } from './create';
import { postgresDialect } from './store-postgres/dialect';
import { createPgliteTestStore } from './store-postgres/testing';
import { sqliteDialect } from './store-sqlite/dialect';
import { createSqliteTestStore } from './store-sqlite/testing';
import { refusalOf } from './testing/conformance';
import { pairTestDevice } from './testing/store';
import {
  createTokenStore,
  formatPairingCode,
  normalizeDeviceName,
  normalizePairingCode,
} from './tokens';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

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
      requests: () => handle.db.selectFrom('pairing_requests').selectAll().execute(),
      tokens,
    };
  }

  test('a request answers a formatted code, a poll secret, its expiry and interval, hashed at rest', async () => {
    const { requests, tokens } = await fixture();
    const request = await tokens.request('laptop');
    expect(request).toEqual({
      expires_at: '2026-10-20T12:10:00.000Z',
      interval: 2,
      poll_secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      user_code: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
    });
    const rows = await requests();
    expect(rows).toEqual([
      {
        approved_at: null,
        created_at: '2026-10-20T12:00:00.000Z',
        denied_at: null,
        device: 'laptop',
        expires_at: '2026-10-20T12:10:00.000Z',
        id: expect.any(String),
        poll_secret_hash: sha256(request.poll_secret),
        user_code_hash: sha256(request.user_code.replace('-', '')),
      },
    ]);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(request.poll_secret);
    expect(stored).not.toContain(request.user_code.replace('-', ''));
  });

  test('a request stays pending until approved, and the first approved poll mints the token once', async () => {
    const { db, requests, tokens } = await fixture();
    const request = await tokens.request('laptop');
    expect(await tokens.poll(request.poll_secret)).toEqual({ status: 'pending' });
    const code = request.user_code.toLowerCase().replace('-', '');
    expect(await tokens.approve(code)).toEqual({ device: 'laptop', rotates: false });
    expect(await tokens.approve(request.user_code)).toBeNull();
    const approved = await tokens.poll(request.poll_secret);
    expect(approved).toEqual({
      device: 'laptop',
      status: 'approved',
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(await tokens.poll(request.poll_secret)).toEqual({ status: 'expired' });
    expect(await requests()).toEqual([]);
    const row = await db.selectFrom('device_tokens').selectAll().executeTakeFirstOrThrow();
    expect(row.token_hash).toBe(sha256(approved.status === 'approved' ? approved.token : ''));
    expect(row.user).toBe('owner');
    expect(row.last_used_at).toBeNull();
    expect(row.revoked_at).toBeNull();
    expect(await tokens.list({ all: true })).toHaveLength(1);
  });

  test('a denied request answers denied once, then expired, and never mints', async () => {
    const { requests, tokens } = await fixture();
    const request = await tokens.request('laptop');
    expect(await tokens.deny(request.user_code)).toEqual({ device: 'laptop' });
    expect(await tokens.deny(request.user_code)).toBeNull();
    expect(await tokens.approve(request.user_code)).toBeNull();
    expect(await tokens.poll(request.poll_secret)).toEqual({ status: 'denied' });
    expect(await tokens.poll(request.poll_secret)).toEqual({ status: 'expired' });
    expect(await requests()).toEqual([]);
    expect(await tokens.list({ all: true })).toEqual([]);
  });

  test('unknown poll secrets and codes match nothing', async () => {
    const { tokens } = await fixture();
    await tokens.request('laptop');
    expect(await tokens.poll('unknown')).toEqual({ status: 'expired' });
    expect(await tokens.approve('ZZZZ-ZZZZ')).toBeNull();
    expect(await tokens.approve('not a code')).toBeNull();
    expect(await tokens.deny('not a code')).toBeNull();
  });

  test('a request expires at ten minutes, even after approval, and later requests purge it', async () => {
    const { advance, requests, tokens } = await fixture();
    const undecided = await tokens.request('undecided');
    const approved = await tokens.request('approved');
    const denied = await tokens.request('denied');
    advance(10 * 60 * 1000 - 1);
    expect(await tokens.approve(approved.user_code)).toEqual({
      device: 'approved',
      rotates: false,
    });
    expect(await tokens.deny(denied.user_code)).toEqual({ device: 'denied' });
    advance(1);
    expect(await tokens.approve(undecided.user_code)).toBeNull();
    expect(await tokens.deny(undecided.user_code)).toBeNull();
    expect(await tokens.listPending()).toEqual([]);
    for (const request of [undecided, approved, denied]) {
      expect(await tokens.poll(request.poll_secret)).toEqual({ status: 'expired' });
    }
    expect(await tokens.list({ all: true })).toEqual([]);
    await tokens.request('stale');
    advance(10 * 60 * 1000);
    await tokens.request('fresh');
    expect((await requests()).map((row) => row.device)).toEqual(['fresh']);
  });

  test('approving a device with an active token reports rotation; the old token stops at mint', async () => {
    const { advance, tokens } = await fixture();
    const first = await pairTestDevice(tokens, 'laptop');
    advance(1000);
    const request = await tokens.request('laptop');
    expect(await tokens.approve(request.user_code)).toEqual({ device: 'laptop', rotates: true });
    expect(await tokens.verify(first)).toBe('laptop');
    const second = await tokens.poll(request.poll_secret);
    expect(second.status).toBe('approved');
    expect(await tokens.verify(first)).toBeNull();
    expect(await tokens.verify(second.status === 'approved' ? second.token : '')).toBe('laptop');
    expect((await tokens.list({ all: true })).map((row) => row.revoked_at)).toEqual([
      '2026-10-20T12:00:01.000Z',
      null,
    ]);
  });

  test('a new request for a device replaces its pending or denied request', async () => {
    const { requests, tokens } = await fixture();
    const pending = await tokens.request('laptop');
    const denied = await tokens.request('laptop');
    expect(await tokens.poll(pending.poll_secret)).toEqual({ status: 'expired' });
    expect(await tokens.approve(pending.user_code)).toBeNull();
    await tokens.deny(denied.user_code);
    const later = await tokens.request('laptop');
    expect(await tokens.poll(denied.poll_secret)).toEqual({ status: 'expired' });
    expect(await requests()).toHaveLength(1);
    expect(await tokens.approve(later.user_code)).toEqual({ device: 'laptop', rotates: false });
    expect((await tokens.poll(later.poll_secret)).status).toBe('approved');
  });

  test('a new request cannot displace an approved, uncollected request until it expires', async () => {
    const { advance, requests, tokens } = await fixture();
    const approved = await tokens.request('laptop');
    await tokens.approve(approved.user_code);
    const refusal = await refusalOf(tokens.request('laptop'));
    expect(refusal).toContain('approved pairing request');
    expect(refusal).toContain('deny or unpair');
    expect((await requests()).map((row) => row.approved_at)).toEqual(['2026-10-20T12:00:00.000Z']);
    advance(10 * 60 * 1000);
    const later = await tokens.request('laptop');
    expect(await tokens.poll(approved.poll_secret)).toEqual({ status: 'expired' });
    expect(await tokens.approve(later.user_code)).toEqual({ device: 'laptop', rotates: false });
  });

  test('denying an approved, uncollected request withdraws the approval before any mint', async () => {
    const { tokens } = await fixture();
    const request = await tokens.request('laptop');
    await tokens.approve(request.user_code);
    expect(await tokens.deny(request.user_code.toLowerCase())).toEqual({ device: 'laptop' });
    expect(await tokens.approve(request.user_code)).toBeNull();
    expect(await tokens.poll(request.poll_secret)).toEqual({ status: 'denied' });
    expect(await tokens.list({ all: true })).toEqual([]);
  });

  test('unpairing a device discards its requests, so an approved one never mints', async () => {
    const { requests, tokens } = await fixture();
    const prior = await pairTestDevice(tokens, 'laptop');
    const request = await tokens.request('laptop');
    await tokens.approve(request.user_code);
    await tokens.request('other');
    expect(await tokens.revoke('laptop')).toEqual({ requests: 1, tokens: 1 });
    expect(await tokens.verify(prior)).toBeNull();
    expect(await tokens.poll(request.poll_secret)).toEqual({ status: 'expired' });
    expect(await tokens.list()).toEqual([]);
    expect((await requests()).map((row) => row.device)).toEqual(['other']);
  });

  test('pending listings show live undecided requests without codes or secrets', async () => {
    const { advance, tokens } = await fixture();
    await tokens.request('workstation');
    advance(1000);
    await tokens.request('laptop');
    const approved = await tokens.request('approved');
    const denied = await tokens.request('denied');
    await tokens.approve(approved.user_code);
    await tokens.deny(denied.user_code);
    expect(await tokens.listPending()).toEqual([
      {
        created_at: '2026-10-20T12:00:00.000Z',
        device: 'workstation',
        expires_at: '2026-10-20T12:10:00.000Z',
      },
      {
        created_at: '2026-10-20T12:00:01.000Z',
        device: 'laptop',
        expires_at: '2026-10-20T12:10:01.000Z',
      },
    ]);
  });

  test('requests normalize the device name and refuse an unusable one', async () => {
    const { requests, tokens } = await fixture();
    await tokens.request('  laptop  ');
    expect((await requests()).map((row) => row.device)).toEqual(['laptop']);
    for (const device of ['', '   ', 'tab\there', 'x'.repeat(129)]) {
      expect(await refusalOf(tokens.request(device))).toContain('device name');
    }
  });

  test('approval accepts Crockford confusables and refuses other syntax', async () => {
    const { db, tokens } = await fixture();
    await db
      .insertInto('pairing_requests')
      .values({
        approved_at: null,
        created_at: '2026-10-20T12:00:00.000Z',
        denied_at: null,
        device: 'confusable',
        expires_at: '2026-10-20T12:10:00.000Z',
        id: 'confusable',
        poll_secret_hash: sha256('secret'),
        user_code_hash: sha256('0101ABCD'),
      })
      .execute();
    expect(await tokens.approve('oIoL-abcd ')).toBeNull();
    expect(await tokens.approve('oIoL-abcd')).toEqual({ device: 'confusable', rotates: false });
  });

  test('verifies, rotates and revokes tokens while retaining history without hashes in listings', async () => {
    const { tokens, advance } = await fixture();
    const first = await pairTestDevice(tokens, 'laptop');
    expect(await tokens.verify(first)).toBe('laptop');
    expect(await tokens.verify('unknown')).toBeNull();
    advance(1000);
    const second = await pairTestDevice(tokens, 'laptop');
    expect(await tokens.verify(first)).toBeNull();
    expect(await tokens.verify(second)).toBe('laptop');
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
    expect(await tokens.revoke('laptop')).toEqual({ requests: 0, tokens: 1 });
    expect(await tokens.revoke('missing')).toEqual({ requests: 0, tokens: 0 });
    expect(await tokens.verify(second)).toBeNull();
    expect(await tokens.list()).toEqual([]);
    expect((await tokens.list({ all: true })).map((row) => row.revoked_at)).toEqual([
      '2026-10-20T12:00:01.000Z',
      '2026-10-20T12:00:01.000Z',
    ]);
  });

  test('updates last_used only after more than five minutes, starting with first use', async () => {
    const { tokens, advance } = await fixture();
    const token = await pairTestDevice(tokens, 'laptop');
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
    const token = await pairTestDevice(tokens, 'laptop');
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
    const token = await pairTestDevice(tokens, 'laptop');
    // A token written by the original injectable-clock implementation.
    await db.updateTable('device_tokens').set({ last_used_at: '2026-10-20T12:00:00Z' }).execute();
    instant = '2026-10-20T12:05:00Z';
    expect(await tokens.verify(token)).toBe('laptop');
    expect((await tokens.list()).at(0)?.last_used_at).toBe('2026-10-20T12:00:00Z');
    instant = '2026-10-20T12:05:00.001Z';
    expect(await tokens.verify(token)).toBe('laptop');
    expect((await tokens.list()).at(0)?.last_used_at).toBe('2026-10-20T12:05:00.001Z');
  });

  test('persists canonical instants for parseable clocks throughout the credential lifecycle', async () => {
    let instant = '2026-10-20T12:00:00+00:00';
    const { requests, tokens } = await fixture(() => instant);
    const request = await tokens.request('laptop');
    expect(request.expires_at).toBe('2026-10-20T12:10:00.000Z');
    expect(await requests()).toMatchObject([
      { created_at: '2026-10-20T12:00:00.000Z', expires_at: '2026-10-20T12:10:00.000Z' },
    ]);
    await tokens.approve(request.user_code);
    expect((await requests()).at(0)?.approved_at).toBe('2026-10-20T12:00:00.000Z');
    const first = await tokens.poll(request.poll_secret);
    expect(await tokens.verify(first.status === 'approved' ? first.token : '')).toBe('laptop');
    expect((await tokens.list()).at(0)).toMatchObject({
      created_at: '2026-10-20T12:00:00.000Z',
      last_used_at: '2026-10-20T12:00:00.000Z',
    });
    instant = '2026-10-20T08:00:01-04:00';
    const denied = await tokens.request('denied');
    await tokens.deny(denied.user_code);
    expect((await requests()).at(0)?.denied_at).toBe('2026-10-20T12:00:01.000Z');
    await pairTestDevice(tokens, 'laptop');
    expect((await tokens.list({ all: true })).at(0)?.revoked_at).toBe('2026-10-20T12:00:01.000Z');
    expect((await tokens.list()).at(0)?.created_at).toBe('2026-10-20T12:00:01.000Z');
    instant = '2026-10-20T12:00:02Z';
    await tokens.revoke('laptop');
    expect((await tokens.list({ all: true })).at(1)?.revoked_at).toBe('2026-10-20T12:00:02.000Z');
  });

  test.each([
    {
      accepted: true,
      label: '500ms before expiry, no milliseconds',
      requested: '2026-10-20T12:00:00.500Z',
      settled: '2026-10-20T12:10:00Z',
    },
    {
      accepted: false,
      label: 'exact expiry, no milliseconds',
      requested: '2026-10-20T12:00:00Z',
      settled: '2026-10-20T12:10:00Z',
    },
    {
      accepted: false,
      label: 'exact expiry, UTC offset without milliseconds',
      requested: '2026-10-20T12:00:00+00:00',
      settled: '2026-10-20T12:10:00+00:00',
    },
    {
      accepted: false,
      label: 'one millisecond after expiry',
      requested: '2026-10-20T12:00:00Z',
      settled: '2026-10-20T12:10:00.001Z',
    },
  ])('compares pairing expiry by instant: $label', async ({ accepted, requested, settled }) => {
    let instant: string = requested;
    const { tokens } = await fixture(() => instant);
    const request = await tokens.request('laptop');
    instant = settled;
    expect((await tokens.approve(request.user_code))?.device ?? null).toBe(
      accepted ? 'laptop' : null,
    );
    expect((await tokens.poll(request.poll_secret)).status).toBe(accepted ? 'approved' : 'expired');
  });

  test('exports work state without credentials and imports without replacing local credentials', async () => {
    const source = await fixture();
    await createProject(source.store, { key: 'DEMO', name: 'Demo' });
    const sourceToken = await pairTestDevice(source.tokens, 'source');
    await source.tokens.request('pending-source');
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
    const targetToken = await pairTestDevice(target.tokens, 'local');
    const pending = await target.tokens.request('pending-local');
    const before = await target.tokens.list({ all: true });
    const enriched = {
      ...document,
      device_tokens: await source.db.selectFrom('device_tokens').selectAll().execute(),
      pairing_requests: await source.requests(),
    };
    await target.store.import(enriched, { dryRun: true, mode: 'fresh' });
    await target.store.import(enriched, { dryRun: false, mode: 'fresh' });
    await target.store.import(enriched, { dryRun: false, mode: 'resume' });
    expect(await target.tokens.list({ all: true })).toEqual(before);
    expect(await target.tokens.verify(sourceToken)).toBeNull();
    expect(await target.tokens.verify(targetToken)).toBe('local');
    expect(await target.tokens.approve(pending.user_code)).toMatchObject({
      device: 'pending-local',
    });
    expect((await target.store.export()).projects).toEqual(document.projects);
    const fresh = await fixture();
    await fresh.store.import(document, { dryRun: false, mode: 'fresh' });
    expect(await fresh.tokens.list({ all: true })).toEqual([]);
    expect(await fresh.requests()).toEqual([]);
  });

  test('enforces one active token per device and unique hashes even for revoked tokens', async () => {
    const { db, tokens } = await fixture();
    await pairTestDevice(tokens, 'laptop');
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

  test('rolls back request consumption and prior revocation if the new token cannot be stored', async () => {
    const { db, tokens } = await fixture();
    const prior = await pairTestDevice(tokens, 'laptop');
    const request = await tokens.request('laptop');
    await tokens.approve(request.user_code);
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
    expect(await refusalOf(tokens.poll(request.poll_secret))).toContain(
      'injected token storage failure',
    );
    expect(await tokens.verify(prior)).toBe('laptop');
    if (name === 'SQLite') {
      await sql.raw('DROP TRIGGER reject_token').execute(db);
    } else {
      await sql.raw('DROP TRIGGER reject_token ON device_tokens').execute(db);
    }
    expect((await tokens.poll(request.poll_secret)).status).toBe('approved');
    expect(await tokens.verify(prior)).toBeNull();
  });

  test('refuses a token revoked between the first read and the usage write transaction', async () => {
    const { db, tokens } = await fixture();
    const token = await pairTestDevice(tokens, 'laptop');
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
    expect(await raced.verify(token)).toBeNull();
    expect((await tokens.list({ all: true })).at(0)?.last_used_at).toBeNull();
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

test('formats a normalized code for display with a middle hyphen', () => {
  expect(formatPairingCode('0111ABCD')).toBe('0111-ABCD');
  expect(normalizePairingCode(formatPairingCode('0111ABCD'))).toBe('0111ABCD');
});

test('normalizes a device name by trimming it and refuses empty, control, or overlong names', () => {
  expect(normalizeDeviceName('  Drews-MacBook-Pro.local ')).toBe('Drews-MacBook-Pro.local');
  expect(normalizeDeviceName('laptop (work)')).toBe('laptop (work)');
  expect(normalizeDeviceName('x'.repeat(128))).toBe('x'.repeat(128));
  for (const input of ['', '  ', 'line\nbreak', 'nul\u0000', 'del\u007F', 'x'.repeat(129)]) {
    expect(normalizeDeviceName(input)).toBeNull();
  }
});
