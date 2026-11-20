import { afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { createPushSubscriptionStore } from './push-subscriptions';
import { postgresDialect } from './store-postgres/dialect';
import { bootPglite, createPgliteTestStore } from './store-postgres/testing';
import { sqliteDialect } from './store-sqlite/dialect';
import { createSqliteTestStore } from './store-sqlite/testing';

beforeAll(bootPglite);

const row = (endpoint: string, overrides: Partial<Parameters<typeof subscribeRow>[1]> = {}) =>
  subscribeRow(endpoint, overrides);

function subscribeRow(
  endpoint: string,
  overrides: {
    p256dh?: string;
    auth?: string;
    serverKey?: string;
    label?: string;
    mutedKinds?: readonly string[];
  },
) {
  return {
    auth: 'auth-1',
    endpoint,
    label: 'Phone',
    p256dh: 'key-1',
    serverKey: 'server-1',
    ...overrides,
  };
}

describe.each([
  { dialect: sqliteDialect, name: 'SQLite', open: createSqliteTestStore },
  { dialect: postgresDialect, name: 'Postgres', open: createPgliteTestStore },
])('$name push subscriptions', ({ dialect, open }) => {
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
    const subscriptions = createPushSubscriptionStore({
      clock: () => time.toISOString(),
      db: handle.db,
      dialect,
    });
    return {
      ...handle,
      advance: (ms: number) => {
        time = new Date(time.getTime() + ms);
      },
      subscriptions,
    };
  }
  const A = 'https://push.example/a';
  const B = 'https://push.example/b';

  test('subscribing a new endpoint stores the row with no outcome', async () => {
    const { subscriptions } = await fixture();
    expect(await subscriptions.subscribe(row(A), 5)).toBe('subscribed');
    expect(await subscriptions.get(A)).toEqual({
      auth: 'auth-1',
      createdAt: '2026-11-01T12:00:00.000Z',
      endpoint: A,
      label: 'Phone',
      mutedKinds: [],
      p256dh: 'key-1',
      serverKey: 'server-1',
    });
    expect(await subscriptions.get(B)).toBeUndefined();
  });

  test('resubscribing replaces keys and label, clears the failure, and keeps created_at and last_success_at', async () => {
    const { advance, subscriptions } = await fixture();
    await subscriptions.subscribe(row(A), 5);
    advance(1000);
    await subscriptions.recordSuccess({
      auth: 'auth-1',
      endpoint: A,
      p256dh: 'key-1',
    });
    advance(1000);
    await subscriptions.recordFailure({ auth: 'auth-1', endpoint: A, p256dh: 'key-1' }, 'HTTP 500');
    advance(1000);
    expect(
      await subscriptions.subscribe(
        row(A, {
          auth: 'auth-2',
          label: 'Tablet',
          p256dh: 'key-2',
          serverKey: 'server-2',
        }),
        1,
      ),
    ).toBe('subscribed');
    expect(await subscriptions.get(A)).toEqual({
      auth: 'auth-2',
      createdAt: '2026-11-01T12:00:00.000Z',
      endpoint: A,
      label: 'Tablet',
      lastSuccessAt: '2026-11-01T12:00:01.000Z',
      mutedKinds: [],
      p256dh: 'key-2',
      serverKey: 'server-2',
    });
  });

  test('a row keeps its muted kinds through a subscribe that names none, and takes those one names', async () => {
    const { subscriptions } = await fixture();
    await subscriptions.subscribe(row(A, { mutedKinds: ['decisions'] }), 5);
    expect((await subscriptions.get(A))?.mutedKinds).toEqual(['decisions']);
    await subscriptions.subscribe(row(A, { auth: 'auth-2' }), 5);
    expect((await subscriptions.get(A))?.mutedKinds).toEqual(['decisions']);
    await subscriptions.subscribe(row(A, { mutedKinds: [] }), 5);
    expect((await subscriptions.get(A))?.mutedKinds).toEqual([]);
  });

  test('setMutedKind mutes or unmutes one kind, keeps the others, and reports whether the row exists', async () => {
    const { subscriptions } = await fixture();
    await subscriptions.subscribe(row(A, { mutedKinds: ['decisions'] }), 5);
    await subscriptions.subscribe(row(B), 5);
    expect(await subscriptions.setMutedKind(A, 'task_blocked', true)).toBe(true);
    expect((await subscriptions.get(A))?.mutedKinds).toEqual(['decisions', 'task_blocked']);
    expect(await subscriptions.setMutedKind(A, 'task_blocked', true)).toBe(true);
    expect((await subscriptions.get(A))?.mutedKinds).toEqual(['decisions', 'task_blocked']);
    expect(await subscriptions.setMutedKind(A, 'decisions', false)).toBe(true);
    expect((await subscriptions.get(A))?.mutedKinds).toEqual(['task_blocked']);
    expect(await subscriptions.setMutedKind(A, 'decisions', false)).toBe(true);
    expect((await subscriptions.get(A))?.mutedKinds).toEqual(['task_blocked']);
    expect((await subscriptions.get(B))?.mutedKinds).toEqual([]);
    expect(await subscriptions.setMutedKind('https://push.example/none', 'decisions', true)).toBe(
      false,
    );
    expect(await subscriptions.get('https://push.example/none')).toBeUndefined();
  });

  test('setMutedKind keeps a name the column holds that is not one of the kinds', async () => {
    const { db, subscriptions } = await fixture();
    await subscriptions.subscribe(row(A), 5);
    await db
      .updateTable('push_subscriptions')
      .set({ muted_kinds: '["retired_kind"]' })
      .where('endpoint', '=', A)
      .execute();
    expect(await subscriptions.setMutedKind(A, 'decisions', true)).toBe(true);
    expect((await subscriptions.get(A))?.mutedKinds).toEqual(['retired_kind', 'decisions']);
  });

  test('the limit refuses a new endpoint but allows an existing one', async () => {
    const { subscriptions } = await fixture();
    expect(await subscriptions.subscribe(row(A), 1)).toBe('subscribed');
    expect(await subscriptions.subscribe(row(B), 1)).toBe('too_many_devices');
    expect(await subscriptions.get(B)).toBeUndefined();
    expect(await subscriptions.subscribe(row(A, { label: 'Renamed' }), 1)).toBe('subscribed');
    expect((await subscriptions.get(A))?.label).toBe('Renamed');
  });

  test('list returns the newest created_at first', async () => {
    const { advance, subscriptions } = await fixture();
    await subscriptions.subscribe(row(A), 5);
    advance(1000);
    await subscriptions.subscribe(row(B), 5);
    expect((await subscriptions.list()).map((r) => r.endpoint)).toEqual([B, A]);
  });

  test('remove deletes by endpoint and reports whether a row went', async () => {
    const { subscriptions } = await fixture();
    await subscriptions.subscribe(row(A), 5);
    expect(await subscriptions.remove(A)).toBe(true);
    expect(await subscriptions.remove(A)).toBe(false);
    expect(await subscriptions.list()).toEqual([]);
  });

  test('removeOtherKeys deletes every row with a different server key and counts them', async () => {
    const { subscriptions } = await fixture();
    await subscriptions.subscribe(row(A, { serverKey: 'old' }), 5);
    await subscriptions.subscribe(row(B, { serverKey: 'new' }), 5);
    await subscriptions.subscribe(row('https://push.example/c', { serverKey: 'old' }), 5);
    expect(await subscriptions.removeOtherKeys('new')).toBe(2);
    expect((await subscriptions.list()).map((r) => r.endpoint)).toEqual([B]);
    expect(await subscriptions.removeOtherKeys('new')).toBe(0);
  });

  test('recordSuccess stamps success and clears the failure while the row matches', async () => {
    const { advance, subscriptions } = await fixture();
    const match = { auth: 'auth-1', endpoint: A, p256dh: 'key-1' };
    await subscriptions.subscribe(row(A), 5);
    await subscriptions.recordFailure(match, 'HTTP 500');
    advance(1000);
    expect(await subscriptions.recordSuccess(match)).toBe(true);
    const stored = await subscriptions.get(A);
    expect(stored?.lastSuccessAt).toBe('2026-11-01T12:00:01.000Z');
    expect(stored?.lastFailureAt).toBeUndefined();
    expect(stored?.lastFailure).toBeUndefined();
  });

  test('recordFailure stamps the failure while the row matches', async () => {
    const { advance, subscriptions } = await fixture();
    const match = { auth: 'auth-1', endpoint: A, p256dh: 'key-1' };
    await subscriptions.subscribe(row(A), 5);
    advance(1000);
    expect(await subscriptions.recordFailure(match, 'HTTP 500')).toBe(true);
    expect(await subscriptions.get(A)).toMatchObject({
      lastFailure: 'HTTP 500',
      lastFailureAt: '2026-11-01T12:00:01.000Z',
    });
  });

  test('removeIfMatches deletes the row while it matches', async () => {
    const { subscriptions } = await fixture();
    await subscriptions.subscribe(row(A), 5);
    expect(
      await subscriptions.removeIfMatches({
        auth: 'auth-1',
        endpoint: A,
        p256dh: 'key-1',
      }),
    ).toBe(true);
    expect(await subscriptions.get(A)).toBeUndefined();
  });

  test('outcome writes are no-ops once the row was removed or resubscribed with new keys', async () => {
    const { subscriptions } = await fixture();
    const stale = { auth: 'auth-1', endpoint: A, p256dh: 'key-1' };
    // Removed.
    expect(await subscriptions.recordSuccess(stale)).toBe(false);
    expect(await subscriptions.recordFailure(stale, 'x')).toBe(false);
    expect(await subscriptions.removeIfMatches(stale)).toBe(false);
    // Resubscribed with a changed p256dh, then a changed auth.
    for (const changed of [{ p256dh: 'key-2' }, { auth: 'auth-2' }]) {
      await subscriptions.subscribe(row(A, changed), 5);
      const before = await subscriptions.get(A);
      expect(await subscriptions.recordSuccess(stale)).toBe(false);
      expect(await subscriptions.recordFailure(stale, 'x')).toBe(false);
      expect(await subscriptions.removeIfMatches(stale)).toBe(false);
      expect(await subscriptions.get(A)).toEqual(before);
      await subscriptions.remove(A);
    }
  });
});
