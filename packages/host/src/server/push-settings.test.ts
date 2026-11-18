import { describe, expect, test } from 'bun:test';

import type { ServeConfig } from '@mimir/core';

import { isPushReady, pushStartupWarnings, readPushSettings } from './push-settings';
import type { PushMisconfiguration } from './push-states';

const KEY = Buffer.alloc(32, 7).toString('base64');
const CONTACT = 'mailto:operator@example.net';
const READY_ENV = { MIMIR_PUSH_CONTACT: CONTACT, MIMIR_SECRET_KEY: KEY };
const READY_SERVE: ServeConfig = { hosts: ['mimir.example'], url: 'https://mimir.example' };

/** The env with each `undefined` entry of the change removed. */
function envWith(change: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...READY_ENV, ...change };
  for (const [name, value] of Object.entries(change)) {
    if (value === undefined) {
      delete env[name];
    }
  }
  return env;
}

describe('readPushSettings', () => {
  test('the channel is absent without MIMIR_PUSH_CONTACT, and the key settings are then ignored', async () => {
    for (const env of [
      {},
      { MIMIR_SECRET_KEY: 'not a key' },
      { MIMIR_SECRET_KEY_FILE: '/missing-key' },
    ]) {
      expect(await readPushSettings(env, {})).toEqual({ enabled: false });
    }
  });

  test('setting both secret key variables refuses startup, with or without the channel', async () => {
    for (const env of [
      { MIMIR_SECRET_KEY: KEY, MIMIR_SECRET_KEY_FILE: '/key' },
      { ...READY_ENV, MIMIR_SECRET_KEY_FILE: '/key' },
    ]) {
      // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
      await expect(readPushSettings(env, READY_SERVE)).rejects.toThrow(
        'MIMIR_SECRET_KEY and MIMIR_SECRET_KEY_FILE cannot both be set',
      );
    }
  });

  test('a fully set up channel carries the contact, the console origin, and the key', async () => {
    const settings = await readPushSettings(READY_ENV, READY_SERVE);
    expect(settings).toMatchObject({
      consoleUrl: 'https://mimir.example',
      contact: CONTACT,
      enabled: true,
      problems: [],
    });
    expect(settings.enabled && settings.key).toBeTruthy();
  });

  test('a development host may serve the console over HTTP on loopback', async () => {
    const settings = await readPushSettings(READY_ENV, {
      hosts: [],
      url: 'http://127.0.0.1:64647',
    });
    expect(settings).toMatchObject({ consoleUrl: 'http://127.0.0.1:64647', problems: [] });
  });

  test('a contact is a mailto: URL with one address, or an https: URL off loopback', async () => {
    for (const contact of [
      'mailto:operator@example.net',
      'mailto:Operator.Name+push@mail.example.net',
      'https://example.net',
      'https://example.net/contact',
    ]) {
      const settings = await readPushSettings(
        envWith({ MIMIR_PUSH_CONTACT: contact }),
        READY_SERVE,
      );
      expect(settings).toMatchObject({ contact, problems: [] });
    }
  });

  test('a malformed contact names MIMIR_PUSH_CONTACT', async () => {
    for (const contact of [
      '',
      'operator@example.net',
      'mailto:',
      'mailto:operator',
      'mailto:a@example.net,b@example.net',
      'mailto:a@example.net?cc=b@example.net',
      'http://example.net',
      'https://localhost',
      'https://127.0.0.1/contact',
      'https://[::1]',
      'ftp://example.net',
    ]) {
      const settings = await readPushSettings(
        envWith({ MIMIR_PUSH_CONTACT: contact }),
        READY_SERVE,
      );
      expect(settings).toMatchObject({
        contact: undefined,
        enabled: true,
        problems: [{ problem: 'malformed', setting: 'MIMIR_PUSH_CONTACT' }],
      });
    }
  });

  test('each other misconfiguration names its setting and degrades instead of refusing startup', async () => {
    const cases: [Record<string, string | undefined>, ServeConfig, PushMisconfiguration][] = [
      [{}, { hosts: ['mimir.example'] }, { problem: 'unset', setting: 'MIMIR_URL' }],
      [
        {},
        { hosts: ['mimir.example'], url: 'http://mimir.example' },
        { problem: 'not HTTPS', setting: 'MIMIR_URL' },
      ],
      [{}, { url: 'https://mimir.example' }, { problem: 'unset', setting: 'MIMIR_HOSTS' }],
      [
        { MIMIR_SECRET_KEY: undefined },
        READY_SERVE,
        { problem: 'missing', setting: 'MIMIR_SECRET_KEY' },
      ],
      [
        { MIMIR_SECRET_KEY: 'short' },
        READY_SERVE,
        { problem: 'malformed', setting: 'MIMIR_SECRET_KEY' },
      ],
      [
        { MIMIR_SECRET_KEY: undefined, MIMIR_SECRET_KEY_FILE: '/missing-key' },
        READY_SERVE,
        { problem: 'unreadable', setting: 'MIMIR_SECRET_KEY_FILE' },
      ],
    ];
    for (const [change, serve, problem] of cases) {
      const settings = await readPushSettings(envWith(change), serve);
      expect(settings).toMatchObject({ enabled: true, problems: [problem] });
    }
  });

  test('the problems come in the order the refinement lists them', async () => {
    const settings = await readPushSettings(
      { MIMIR_PUSH_CONTACT: 'nobody', MIMIR_SECRET_KEY: 'short' },
      { url: 'http://mimir.example' },
    );
    expect(settings).toMatchObject({
      key: undefined,
      problems: [
        { problem: 'malformed', setting: 'MIMIR_PUSH_CONTACT' },
        { problem: 'not HTTPS', setting: 'MIMIR_URL' },
        { problem: 'unset', setting: 'MIMIR_HOSTS' },
        { problem: 'malformed', setting: 'MIMIR_SECRET_KEY' },
      ],
    });
  });

  test('a key file is read strictly, trimming only surrounding whitespace', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'push-secret-key-'));
    try {
      const file = join(root, 'key');
      const env = envWith({ MIMIR_SECRET_KEY: undefined, MIMIR_SECRET_KEY_FILE: file });
      await writeFile(file, `${KEY}\n`);
      const usable = await readPushSettings(env, READY_SERVE);
      expect(usable).toMatchObject({ problems: [] });
      expect(usable.enabled && usable.key).toBeTruthy();
      await writeFile(file, 'not a key\n');
      expect(await readPushSettings(env, READY_SERVE)).toMatchObject({
        key: undefined,
        problems: [{ problem: 'malformed', setting: 'MIMIR_SECRET_KEY_FILE' }],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe('pushStartupWarnings', () => {
  test('names each setting and problem, never a value', async () => {
    const settings = await readPushSettings(
      { MIMIR_PUSH_CONTACT: 'mailto:private-contact', MIMIR_SECRET_KEY: 'c2VjcmV0LXZhbHVl' },
      { url: 'http://private-host.example' },
    );
    const warnings = pushStartupWarnings(settings);
    expect(warnings).toEqual([
      expect.stringContaining('MIMIR_PUSH_CONTACT is malformed'),
      expect.stringContaining('MIMIR_URL is not HTTPS'),
      expect.stringContaining('MIMIR_HOSTS is unset'),
      expect.stringContaining('MIMIR_SECRET_KEY is malformed'),
    ]);
    const text = warnings.join('\n');
    expect(text).not.toContain('private-contact');
    expect(text).not.toContain('private-host');
    expect(text).not.toContain('c2VjcmV0LXZhbHVl');
  });

  test('warns nothing when the channel is absent or ready', async () => {
    expect(pushStartupWarnings(await readPushSettings({}, {}))).toEqual([]);
    expect(pushStartupWarnings(await readPushSettings(READY_ENV, READY_SERVE))).toEqual([]);
  });
});

describe('isPushReady', () => {
  test('only a channel set up with no problem is handed to the notifier', async () => {
    expect(isPushReady(await readPushSettings(READY_ENV, READY_SERVE))).toBe(true);
    expect(isPushReady(await readPushSettings({}, READY_SERVE))).toBe(false);
    expect(isPushReady(await readPushSettings(READY_ENV, { url: 'https://mimir.example' }))).toBe(
      false,
    );
  });
});
