import { afterEach, describe, expect, test } from 'bun:test';

import {
  createHostSecretStore,
  createPushSubscriptionStore,
  parseSecretKey,
  sealSecret,
  sqliteDialect,
} from '@mimir/core';
import type { HostSecretStore, PushSubscriptionStore } from '@mimir/core';
import { createSqliteTestStore } from '@mimir/core/testing';

import type { NotificationEvent } from './notification-events';
import { createPushChannel, PUSH_DEVICE_LIMIT, PUSH_SECRET_NAME } from './push-channel';
import type { PushChannelOptions } from './push-channel';
import { decryptPushBody, makeBrowserKeys, verifyJwt } from './push-fixtures';
import type { BrowserKeys } from './push-fixtures';
import { readVapidKeys } from './push-protocol';
import type { PushSettings } from './push-settings';
import { deferred, stubPushService } from './push-stub';
import type { StubPushAnswer } from './push-stub';

const KEY = parseSecretKey(Buffer.alloc(32, 7).toString('base64'))!;
const OTHER_KEY = parseSecretKey(Buffer.alloc(32, 9).toString('base64'))!;
const CONSOLE = 'https://mimir.example';
const CONTACT = 'mailto:operator@example.net';
const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const READY: PushSettings = {
  consoleUrl: CONSOLE,
  contact: CONTACT,
  enabled: true,
  key: KEY,
  problems: [],
};
const APPLE = 'https://web.push.apple.com/device-one';
const GOOGLE = 'https://fcm.googleapis.com/fcm/send/device-two';

const EVENT: NotificationEvent = {
  body: 'Which store backs the cache?',
  ids: ['MMR-d1'],
  kind: 'decisions',
  needs_you: 3,
  project: 'MMR',
  target: '/p/MMR/d1?mode=decisions',
  title: 'Decision on Cache rework',
};

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) {
    await close();
  }
});

type Rig = {
  channel: ReturnType<typeof createPushChannel>;
  secrets: HostSecretStore;
  subscriptions: PushSubscriptionStore;
  service: ReturnType<typeof stubPushService>;
  lines: string[];
  events: () => Record<string, unknown>[];
};

/** A channel over a real SQLite store and a stub push service. */
async function rig(
  options: {
    settings?: PushSettings;
    answers?: Record<string, StubPushAnswer>;
    secrets?: (real: HostSecretStore) => HostSecretStore;
    subscriptions?: (real: PushSubscriptionStore) => PushSubscriptionStore;
    timeoutMs?: number;
  } = {},
): Promise<Rig> {
  const sqlite = await createSqliteTestStore();
  closes.push(sqlite.close);
  const realSecrets = createHostSecretStore({ db: sqlite.db, dialect: sqliteDialect });
  const realSubscriptions = createPushSubscriptionStore({ db: sqlite.db, dialect: sqliteDialect });
  return withStores(realSecrets, realSubscriptions, options);
}

function withStores(
  realSecrets: HostSecretStore,
  realSubscriptions: PushSubscriptionStore,
  options: Parameters<typeof rig>[0] = {},
): Rig {
  const secrets = options.secrets?.(realSecrets) ?? realSecrets;
  const subscriptions = options.subscriptions?.(realSubscriptions) ?? realSubscriptions;
  const service = stubPushService(options.answers);
  const lines: string[] = [];
  const channelOptions: PushChannelOptions = {
    clock: () => NOW,
    fetch: service.fetch,
    log: (line) => lines.push(line),
    secrets,
    settings: options.settings ?? READY,
    subscriptions,
    timeoutMs: options.timeoutMs ?? 1_000,
  };
  return {
    channel: createPushChannel(channelOptions),
    events: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    lines,
    secrets: realSecrets,
    service,
    subscriptions: realSubscriptions,
  };
}

async function publicKeyOf(channel: Rig['channel']): Promise<string> {
  const status = await channel.status();
  if (status.state !== 'ready') {
    throw new Error(`the channel is ${status.state}`);
  }
  return status.publicKey;
}

/** Subscribe a new browser to the endpoint with the current key, from the console's origin. */
async function subscribed(
  { channel }: Rig,
  endpoint: string,
  label = 'Phone',
): Promise<BrowserKeys> {
  const browser = await makeBrowserKeys();
  const answer = await channel.subscribe(
    {
      auth: browser.auth,
      endpoint,
      label,
      p256dh: browser.p256dh,
      serverKey: await publicKeyOf(channel),
    },
    CONSOLE,
  );
  expect(answer).toEqual({ state: 'subscribed' });
  return browser;
}

describe('an absent or misconfigured channel', () => {
  test('without the setting, every function answers unconfigured and nothing is written', async () => {
    const r = await rig({ settings: { enabled: false } });
    const browser = await makeBrowserKeys();
    expect(await r.channel.status()).toEqual({ state: 'unconfigured' });
    expect(
      await r.channel.subscribe(
        { ...browser, endpoint: APPLE, label: 'Phone', serverKey: 'x' },
        CONSOLE,
      ),
    ).toEqual({ state: 'unconfigured' });
    expect(await r.channel.list()).toEqual({ state: 'unconfigured' });
    expect(await r.channel.sendTest(APPLE)).toEqual({ state: 'unconfigured' });
    expect(await r.channel.unsubscribe(APPLE)).toEqual({ state: 'unconfigured' });
    expect(await r.channel.resetKey()).toEqual({ state: 'unconfigured' });
    await r.channel.deliver(EVENT);
    expect(await r.secrets.read(PUSH_SECRET_NAME)).toBeUndefined();
    expect(await r.subscriptions.list()).toEqual([]);
    expect(r.service.requests).toEqual([]);
  });

  test('without a usable secret key, every function answers misconfigured with the first problem', async () => {
    const r = await rig({
      settings: {
        ...READY,
        key: undefined,
        problems: [
          { problem: 'unset', setting: 'MIMIR_HOSTS' },
          { problem: 'missing', setting: 'MIMIR_SECRET_KEY' },
        ],
      },
    });
    const misconfigured = {
      problem: 'unset',
      setting: 'MIMIR_HOSTS',
      state: 'misconfigured',
    } as const;
    expect(await r.channel.status()).toEqual(misconfigured);
    expect(await r.channel.resetKey()).toEqual(misconfigured);
    expect(await r.channel.list()).toEqual(misconfigured);
    expect(await r.secrets.read(PUSH_SECRET_NAME)).toBeUndefined();
  });
});

describe('delivering an event', () => {
  test('a subscribed device receives a push that decrypts with its keys to the event payload', async () => {
    const r = await rig();
    const browser = await subscribed(r, APPLE);
    await r.channel.deliver(EVENT);
    expect(r.service.requests).toHaveLength(1);
    const [request] = r.service.requests;
    expect(request?.endpoint).toBe(APPLE);
    expect(request?.method).toBe('POST');
    expect(request?.redirect).toBe('manual');
    expect(JSON.parse(await decryptPushBody(request!.body, browser))).toEqual({
      app_badge: 3,
      notification: {
        body: 'Which store backs the cache?',
        dir: 'ltr',
        lang: 'en',
        navigate: 'https://mimir.example/p/MMR/d1?mode=decisions',
        tag: 'decisions:/p/MMR/d1?mode=decisions',
        title: 'Decision on Cache rework',
      },
      web_push: 8030,
    });
    const { authorization, ...rest } = request!.headers;
    expect(rest).toEqual({
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '86400',
      urgency: 'high',
    });
    const publicKey = await publicKeyOf(r.channel);
    const jwt = /^vapid t=([^,]+), k=(.+)$/.exec(authorization ?? '');
    expect(jwt?.[2]).toBe(publicKey);
    expect((await verifyJwt(jwt?.[1] ?? '', publicKey)).claims).toEqual({
      aud: 'https://web.push.apple.com',
      exp: NOW / 1000 + 12 * 3600,
      sub: CONTACT,
    });
    expect((await r.subscriptions.get(APPLE))?.lastSuccessAt).toEqual(expect.any(String));
    expect(r.lines).toEqual([]);
  });

  test('every current-key row is sent to at once, and a row made for another key is skipped', async () => {
    const both = deferred<number>();
    let arrived = 0;
    const waitForBoth = async () => {
      arrived += 1;
      if (arrived === 2) {
        both.resolve(201);
      }
      return both.promise;
    };
    const r = await rig({ answers: { [APPLE]: waitForBoth, [GOOGLE]: waitForBoth } });
    await subscribed(r, APPLE);
    await subscribed(r, GOOGLE);
    const stale = await makeBrowserKeys();
    const staleEndpoint = 'https://web.push.apple.com/stale';
    await r.subscriptions.subscribe(
      { ...stale, endpoint: staleEndpoint, label: 'Old', serverKey: 'another-key' },
      PUSH_DEVICE_LIMIT,
    );
    await r.channel.deliver(EVENT);
    expect(r.service.requests.map((request) => request.endpoint).toSorted()).toEqual([
      GOOGLE,
      APPLE,
    ]);
  });

  test('a 410 or a 404 removes the subscription and logs the host and status only', async () => {
    const r = await rig({ answers: { [APPLE]: 410, [GOOGLE]: 404 } });
    await subscribed(r, APPLE);
    await subscribed(r, GOOGLE);
    await r.channel.deliver(EVENT);
    expect(await r.subscriptions.list()).toEqual([]);
    expect(r.events()).toEqual(
      expect.arrayContaining([
        {
          event: 'push_subscription_gone',
          host: 'web.push.apple.com',
          status: 410,
          time: expect.any(String),
        },
        {
          event: 'push_subscription_gone',
          host: 'fcm.googleapis.com',
          status: 404,
          time: expect.any(String),
        },
      ]),
    );
    expect(r.lines.join('\n')).not.toContain('device-one');
  });

  test('another status records the failure, and a later success clears it', async () => {
    const r = await rig({ answers: { [APPLE]: 500 } });
    await subscribed(r, APPLE);
    await r.channel.deliver(EVENT);
    expect(await r.subscriptions.get(APPLE)).toMatchObject({
      lastFailure: 'HTTP 500',
      lastFailureAt: expect.any(String),
    });
    expect(r.events()).toEqual([
      {
        event: 'push_send_fault',
        host: 'web.push.apple.com',
        status: 500,
        time: expect.any(String),
      },
    ]);
    r.service.answers[APPLE] = 201;
    await r.channel.deliver(EVENT);
    const row = await r.subscriptions.get(APPLE);
    expect(row?.lastFailure).toBeUndefined();
    expect(row?.lastSuccessAt).toEqual(expect.any(String));
  });

  test('a redirect is a failure, never followed', async () => {
    const r = await rig({ answers: { [APPLE]: 302 } });
    await subscribed(r, APPLE);
    await r.channel.deliver(EVENT);
    expect(r.service.requests).toHaveLength(1);
    expect((await r.subscriptions.get(APPLE))?.lastFailure).toBe('HTTP 302');
  });

  test('no answer in time is a timeout, and a network failure is unreachable', async () => {
    const r = await rig({ answers: { [APPLE]: 'hang', [GOOGLE]: 'unreachable' }, timeoutMs: 20 });
    await subscribed(r, APPLE);
    await subscribed(r, GOOGLE);
    await r.channel.deliver(EVENT);
    expect((await r.subscriptions.get(APPLE))?.lastFailure).toBe('timeout');
    expect((await r.subscriptions.get(GOOGLE))?.lastFailure).toBe('unreachable');
    expect(r.events()).toEqual(
      expect.arrayContaining([
        {
          event: 'push_send_fault',
          host: 'web.push.apple.com',
          status: 'timeout',
          time: expect.any(String),
        },
        {
          event: 'push_send_fault',
          host: 'fcm.googleapis.com',
          status: 'unreachable',
          time: expect.any(String),
        },
      ]),
    );
  });

  test('a late outcome leaves alone a row subscribed again with new keys while the push was in flight', async () => {
    const arrived = deferred<void>();
    const answer = deferred<number>();
    const r = await rig({
      answers: {
        [APPLE]: async () => {
          arrived.resolve();
          return answer.promise;
        },
      },
    });
    await subscribed(r, APPLE, 'First');
    const delivering = r.channel.deliver(EVENT);
    await arrived.promise;
    const second = await subscribed(r, APPLE, 'Second');
    answer.resolve(410);
    await delivering;
    expect(await r.subscriptions.get(APPLE)).toMatchObject({
      auth: second.auth,
      label: 'Second',
      p256dh: second.p256dh,
    });
  });

  test('a push that cannot be built is logged as a build fault, leaves its row alone, and stops no other row', async () => {
    const r = await rig();
    await subscribed(r, GOOGLE);
    // A stored key that no longer decodes to a P-256 point: a local fault, not the push service's.
    await r.subscriptions.subscribe(
      {
        ...(await makeBrowserKeys()),
        endpoint: APPLE,
        label: 'Corrupt',
        p256dh: 'BAAA',
        serverKey: await publicKeyOf(r.channel),
      },
      PUSH_DEVICE_LIMIT,
    );
    await r.channel.deliver(EVENT);
    expect(r.service.requests.map((request) => request.endpoint)).toEqual([GOOGLE]);
    expect((await r.subscriptions.get(GOOGLE))?.lastSuccessAt).toEqual(expect.any(String));
    const corrupt = await r.subscriptions.get(APPLE);
    expect(corrupt?.lastFailure).toBeUndefined();
    expect(corrupt?.lastFailureAt).toBeUndefined();
    expect(r.events()).toEqual([
      { event: 'push_build_fault', host: 'web.push.apple.com', time: expect.any(String) },
    ]);
    // A test push to that row is a host fault, not an answer about the push service.
    // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
    await expect(r.channel.sendTest(APPLE)).rejects.toThrow();
    expect((await r.subscriptions.get(APPLE))?.lastFailure).toBeUndefined();
  });

  test('a failed outcome write is logged with the host and does not reject', async () => {
    const r = await rig({
      subscriptions: (real) => ({
        ...real,
        recordSuccess: async () => {
          throw new Error('database is locked');
        },
      }),
    });
    await subscribed(r, APPLE);
    await r.channel.deliver(EVENT);
    expect(r.events()).toEqual([
      { event: 'push_outcome_write_fault', host: 'web.push.apple.com', time: expect.any(String) },
    ]);
  });

  test('rejects when the table or the key cannot be read', async () => {
    const tableDown = await rig({
      subscriptions: (real) => ({
        ...real,
        list: async () => {
          throw new Error('database is locked');
        },
      }),
    });
    // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
    await expect(tableDown.channel.deliver(EVENT)).rejects.toThrow('database is locked');
    const keyDown = await rig({
      secrets: (real) => ({
        ...real,
        read: async () => {
          throw new Error('database is locked');
        },
      }),
    });
    // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
    await expect(keyDown.channel.deliver(EVENT)).rejects.toThrow('database is locked');
  });
});

/** A store write that fails as a locked database does. */
async function locked(): Promise<never> {
  throw new Error('database is locked');
}

/** Subscribe a new browser to APPLE with the current key, changed as given. */
async function attempt(
  r: Rig,
  change: Record<string, string> = {},
  origin: string | null = CONSOLE,
) {
  const browser = await makeBrowserKeys();
  return r.channel.subscribe(
    {
      auth: browser.auth,
      endpoint: APPLE,
      label: 'Phone',
      p256dh: browser.p256dh,
      serverKey: await publicKeyOf(r.channel),
      ...change,
    },
    origin,
  );
}

describe('subscribing', () => {
  test('refuses a missing or foreign Origin, comparing scheme, host, and port', async () => {
    const r = await rig();
    for (const origin of [
      null,
      'null',
      'http://mimir.example',
      'https://evil.example',
      'https://mimir.example:8443',
      'https://mimir.example.evil.net',
    ]) {
      expect(await attempt(r, {}, origin)).toEqual({ state: 'wrong_origin' });
    }
    expect(await attempt(r, {}, 'https://MIMIR.example:443')).toEqual({ state: 'subscribed' });
  });

  test('refuses a server key that is not the current one', async () => {
    const r = await rig();
    expect(await attempt(r, { serverKey: 'BOld' })).toEqual({ state: 'stale_key' });
    expect(await r.subscriptions.list()).toEqual([]);
  });

  test('refuses an endpoint outside the allowlist', async () => {
    const r = await rig();
    for (const endpoint of [
      'https://push.example.net/abc',
      'http://web.push.apple.com/abc',
      'https://web.push.apple.com:8443/abc',
      `https://web.push.apple.com/${'a'.repeat(1024)}`,
    ]) {
      expect(await attempt(r, { endpoint })).toEqual({ state: 'endpoint_not_allowed' });
    }
    expect(await r.subscriptions.list()).toEqual([]);
  });

  test('refuses browser keys that are not a P-256 point and a 16-byte secret', async () => {
    const r = await rig();
    expect(await attempt(r, { p256dh: 'BAAA' })).toEqual({ state: 'invalid_keys' });
    expect(await attempt(r, { auth: Buffer.alloc(15).toString('base64url') })).toEqual({
      state: 'invalid_keys',
    });
    expect(await r.subscriptions.list()).toEqual([]);
  });

  test(`refuses a new endpoint past ${String(20)} devices, but still replaces a known one`, async () => {
    expect(PUSH_DEVICE_LIMIT).toBe(20);
    const r = await rig();
    for (let index = 0; index < PUSH_DEVICE_LIMIT; index += 1) {
      await subscribed(r, `https://web.push.apple.com/device-${String(index)}`);
    }
    expect(await attempt(r, { endpoint: 'https://web.push.apple.com/one-more' })).toEqual({
      state: 'too_many_devices',
    });
    expect(await attempt(r, { endpoint: 'https://web.push.apple.com/device-3' })).toEqual({
      state: 'subscribed',
    });
  });

  test('stores the serialized endpoint and a plain label, and a resubscribe keeps created_at', async () => {
    const r = await rig({ answers: { [APPLE]: 500 } });
    await subscribed(r, 'https://WEB.push.apple.com:443/device-one', '  My\n\tphone  ');
    await r.channel.deliver(EVENT);
    const first = await r.subscriptions.get(APPLE);
    expect(first).toMatchObject({ label: 'My phone', lastFailure: 'HTTP 500' });
    await subscribed(r, APPLE, '   ');
    const second = await r.subscriptions.get(APPLE);
    expect(second).toMatchObject({ createdAt: first?.createdAt, label: 'Device' });
    expect(second?.lastFailure).toBeUndefined();
    await subscribed(r, APPLE, `${'x'.repeat(59)}😀more`);
    expect((await r.subscriptions.get(APPLE))?.label).toBe(`${'x'.repeat(59)}😀`);
  });
});

describe('the device list, test push, and unsubscribe', () => {
  test('lists rows newest first, without keys, marking those made for the current key', async () => {
    const r = await rig();
    await subscribed(r, APPLE, 'Phone');
    await r.subscriptions.subscribe(
      { ...(await makeBrowserKeys()), endpoint: GOOGLE, label: 'Old', serverKey: 'old' },
      PUSH_DEVICE_LIMIT,
    );
    const listed = await r.channel.list();
    expect(listed).toEqual({
      devices: expect.arrayContaining([
        { createdAt: expect.any(String), currentKey: true, endpoint: APPLE, label: 'Phone' },
        { createdAt: expect.any(String), currentKey: false, endpoint: GOOGLE, label: 'Old' },
      ]),
      state: 'listed',
    });
  });

  test('a test push answers delivered, gone, or failed, and only to its own endpoint', async () => {
    const r = await rig({ answers: { [GOOGLE]: 503 } });
    const browser = await subscribed(r, APPLE);
    await subscribed(r, GOOGLE);
    expect(await r.channel.sendTest('https://web.push.APPLE.com/device-one')).toEqual({
      state: 'delivered',
    });
    expect(r.service.requests.map((request) => request.endpoint)).toEqual([APPLE]);
    expect(JSON.parse(await decryptPushBody(r.service.requests[0]!.body, browser))).toEqual({
      notification: {
        body: 'Notifications reach this device.',
        dir: 'ltr',
        lang: 'en',
        navigate: 'https://mimir.example/',
        tag: 'test',
        title: 'Mimir test notification',
      },
      web_push: 8030,
    });
    expect(await r.channel.sendTest(GOOGLE)).toEqual({ failure: 'HTTP 503', state: 'failed' });
    r.service.answers[GOOGLE] = 410;
    expect(await r.channel.sendTest(GOOGLE)).toEqual({ state: 'gone' });
    expect(await r.subscriptions.get(GOOGLE)).toBeUndefined();
  });

  test('a test push whose outcome write fails rejects as a host fault, never answering gone or delivered', async () => {
    const r = await rig({
      answers: { [GOOGLE]: 410 },
      subscriptions: (real) => ({ ...real, recordSuccess: locked, removeIfMatches: locked }),
    });
    await subscribed(r, APPLE);
    await subscribed(r, GOOGLE);
    // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
    await expect(r.channel.sendTest(APPLE)).rejects.toThrow('database is locked');
    // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
    await expect(r.channel.sendTest(GOOGLE)).rejects.toThrow('database is locked');
    expect(await r.subscriptions.get(GOOGLE)).toBeDefined();
  });

  test('a test push to no row is not_found, and to a row made for another key is stale_key', async () => {
    const r = await rig();
    expect(await r.channel.sendTest(APPLE)).toEqual({ state: 'not_found' });
    expect(await r.channel.sendTest('not a url')).toEqual({ state: 'not_found' });
    await r.subscriptions.subscribe(
      { ...(await makeBrowserKeys()), endpoint: GOOGLE, label: 'Old', serverKey: 'old' },
      PUSH_DEVICE_LIMIT,
    );
    expect(await r.channel.sendTest(GOOGLE)).toEqual({ state: 'stale_key' });
    expect(r.service.requests).toEqual([]);
  });

  test('unsubscribe deletes the serialized endpoint, and no row is not an error', async () => {
    const r = await rig();
    await subscribed(r, APPLE);
    expect(await r.channel.unsubscribe('https://web.push.apple.com:443/device-one')).toEqual({
      state: 'unsubscribed',
    });
    expect(await r.subscriptions.list()).toEqual([]);
    expect(await r.channel.unsubscribe(APPLE)).toEqual({ state: 'unsubscribed' });
  });
});

/** The public key the store holds now, opened as the channel opens it. */
async function storedPublicKey(r: Rig): Promise<string | undefined> {
  const { openSecret } = await import('@mimir/core');
  const sealed = await r.secrets.read(PUSH_SECRET_NAME);
  const pair = await readVapidKeys(
    JSON.parse(openSecret(KEY, PUSH_SECRET_NAME, sealed ?? '') ?? 'null'),
  );
  return pair?.publicKey;
}

/** Settle when the promise does, or after the wait, whichever comes first. */
async function settledOrAfter(promise: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([promise, Bun.sleep(ms)]);
}

describe('the VAPID key', () => {
  test('concurrent first uses store one pair, and every caller uses it', async () => {
    let inserts = 0;
    const r = await rig({
      secrets: (real) => ({
        ...real,
        insertIfAbsent: async (name, sealed) => {
          inserts += 1;
          return real.insertIfAbsent(name, sealed);
        },
      }),
    });
    const keys = await Promise.all(Array.from({ length: 5 }, () => publicKeyOf(r.channel)));
    expect(new Set(keys).size).toBe(1);
    expect(inserts).toBe(1);
    expect(await publicKeyOf(r.channel)).toBe(keys[0]!);
  });

  test('two hosts on one store making a pair at once both use the one stored first', async () => {
    const first = await rig();
    const second = withStores(first.secrets, first.subscriptions);
    const [a, b] = await Promise.all([publicKeyOf(first.channel), publicKeyOf(second.channel)]);
    expect(a).toBe(b);
  });

  test('every use reads the row: a key another host reset is used at once', async () => {
    const first = await rig();
    const second = withStores(first.secrets, first.subscriptions);
    const before = await publicKeyOf(first.channel);
    const reset = await second.channel.resetKey();
    expect(reset).toEqual({ publicKey: expect.any(String), state: 'reset' });
    expect(await publicKeyOf(first.channel)).not.toBe(before);
    expect(await publicKeyOf(first.channel)).toBe(reset.state === 'reset' ? reset.publicKey : '');
  });

  test('a failed attempt is not remembered, and a store read error makes no pair', async () => {
    let failInsert = true;
    let failRead = false;
    let inserts = 0;
    const r = await rig({
      secrets: (real) => ({
        ...real,
        insertIfAbsent: async (name, sealed) => {
          inserts += 1;
          if (failInsert) {
            throw new Error('disk full');
          }
          return real.insertIfAbsent(name, sealed);
        },
        read: async (name) => {
          if (failRead) {
            throw new Error('database is locked');
          }
          return real.read(name);
        },
      }),
    });
    // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
    await expect(r.channel.status()).rejects.toThrow('disk full');
    failInsert = false;
    expect((await r.channel.status()).state).toBe('ready');
    failRead = true;
    const before = inserts;
    // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
    await expect(r.channel.status()).rejects.toThrow('database is locked');
    expect(inserts).toBe(before);
  });

  test('an unopenable row is key_unusable, logged once, and never replaced on its own', async () => {
    const r = await rig();
    const sealed = sealSecret(OTHER_KEY, PUSH_SECRET_NAME, '{}');
    await r.secrets.write(PUSH_SECRET_NAME, sealed);
    await r.subscriptions.subscribe(
      { ...(await makeBrowserKeys()), endpoint: APPLE, label: 'Phone', serverKey: 'k' },
      PUSH_DEVICE_LIMIT,
    );
    expect(await r.channel.status()).toEqual({ state: 'key_unusable' });
    expect(await r.channel.status()).toEqual({ state: 'key_unusable' });
    const browser = await makeBrowserKeys();
    expect(
      await r.channel.subscribe(
        { ...browser, endpoint: GOOGLE, label: 'x', serverKey: 'k' },
        CONSOLE,
      ),
    ).toEqual({ state: 'key_unusable' });
    expect(await r.channel.sendTest(APPLE)).toEqual({ state: 'key_unusable' });
    expect(await r.channel.list()).toEqual({
      devices: [
        { createdAt: expect.any(String), currentKey: false, endpoint: APPLE, label: 'Phone' },
      ],
      state: 'listed',
    });
    await r.channel.deliver(EVENT);
    expect(r.service.requests).toEqual([]);
    expect(await r.secrets.read(PUSH_SECRET_NAME)).toBe(sealed);
    expect(r.events()).toEqual([
      {
        cause: 'the row failed authentication: the key changed or the row was altered',
        event: 'host_secret_unopenable',
        name: PUSH_SECRET_NAME,
        time: expect.any(String),
      },
    ]);
    expect(await r.channel.unsubscribe(APPLE)).toEqual({ state: 'unsubscribed' });
    const reset = await r.channel.resetKey();
    expect(reset.state).toBe('reset');
    expect((await r.channel.status()).state).toBe('ready');
  });

  test('a row that opens but holds no valid pair is key_unusable, logged as unreadable', async () => {
    const r = await rig();
    await r.secrets.write(PUSH_SECRET_NAME, sealSecret(KEY, PUSH_SECRET_NAME, '{"publicKey":"x"}'));
    expect(await r.channel.status()).toEqual({ state: 'key_unusable' });
    await r.channel.status();
    expect(r.events()).toEqual([
      { event: 'host_secret_unreadable', name: PUSH_SECRET_NAME, time: expect.any(String) },
    ]);
  });

  test('the stored row is the sealed pair, and the private scalar appears in no answer or log', async () => {
    const r = await rig();
    const publicKey = await publicKeyOf(r.channel);
    const sealed = await r.secrets.read(PUSH_SECRET_NAME);
    const { openSecret } = await import('@mimir/core');
    const pair = await readVapidKeys(
      JSON.parse(openSecret(KEY, PUSH_SECRET_NAME, sealed ?? '') ?? ''),
    );
    expect(pair?.publicKey).toBe(publicKey);
    expect(JSON.stringify(await r.channel.status())).not.toContain(pair?.privateKey ?? '?');
  });

  test('a subscribe and a reset in one process never leave a row made for the replaced key', async () => {
    const reachedWrite = deferred<void>();
    const release = deferred<void>();
    const r = await rig({
      subscriptions: (real) => ({
        ...real,
        subscribe: async (row, limit) => {
          reachedWrite.resolve();
          await release.promise;
          return real.subscribe(row, limit);
        },
      }),
    });
    const subscribing = attempt(r);
    await reachedWrite.promise;
    const resetting = r.channel.resetKey();
    // A reset that does not wait for the subscribe finishes while the write is held.
    await settledOrAfter(resetting, 200);
    release.resolve();
    expect(await subscribing).toEqual({ state: 'subscribed' });
    const reset = await resetting;
    expect(reset.state === 'reset' && reset.publicKey).toBe((await storedPublicKey(r))!);
    expect(await r.subscriptions.list()).toEqual([]);
  });

  test('two resets in one process take turns: each deletion keeps the rows of the key the store holds', async () => {
    const r = await rig();
    await publicKeyOf(r.channel);
    const firstRemoval = deferred<void>();
    const secondSettled = deferred<void>();
    const removals: { kept: string; stored: string | undefined }[] = [];
    let calls = 0;
    const gated = withStores(r.secrets, r.subscriptions, {
      subscriptions: (real) => ({
        ...real,
        removeOtherKeys: async (kept) => {
          calls += 1;
          if (calls === 1) {
            firstRemoval.resolve();
            await settledOrAfter(secondSettled.promise, 200);
          }
          removals.push({ kept, stored: await storedPublicKey(r) });
          return real.removeOtherKeys(kept);
        },
      }),
    });
    const first = gated.channel.resetKey();
    await firstRemoval.promise;
    const second = (async () => {
      try {
        return await gated.channel.resetKey();
      } finally {
        secondSettled.resolve();
      }
    })();
    const answers = await Promise.all([first, second]);
    expect(removals).toHaveLength(2);
    for (const removal of removals) {
      expect(removal.kept).toBe(removal.stored!);
    }
    expect(answers[1].state === 'reset' && answers[1].publicKey).toBe((await storedPublicKey(r))!);
  });

  test('a reset answers the new key and deletes every subscription made for another key', async () => {
    const r = await rig();
    await subscribed(r, APPLE);
    const before = await publicKeyOf(r.channel);
    const reset = await r.channel.resetKey();
    if (reset.state !== 'reset') {
      throw new Error(reset.state);
    }
    expect(reset.publicKey).not.toBe(before);
    expect(await publicKeyOf(r.channel)).toBe(reset.publicKey);
    expect(await r.subscriptions.list()).toEqual([]);
    const browser = await makeBrowserKeys();
    expect(
      await r.channel.subscribe(
        { ...browser, endpoint: APPLE, label: 'x', serverKey: before },
        CONSOLE,
      ),
    ).toEqual({ state: 'stale_key' });
  });
});
