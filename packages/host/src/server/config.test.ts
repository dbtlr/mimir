import { expect, test } from 'bun:test';

import { readHostConfig } from './config';

test('host defaults select isolated SQLite and the standard port', async () => {
  expect(await readHostConfig({})).toEqual({
    agent: { enabled: false },
    dataDirectory: expect.stringContaining('.dev/host'),
    gitCredentials: { configured: false },
    port: 64647,
    serve: {},
    store: { backend: 'sqlite' },
    t3: { enabled: false },
  });
});

test('host validates environment configuration and refuses conflicting URLs', async () => {
  const config = await readHostConfig({
    MIMIR_DATABASE_URL: 'postgres://user:secret@db/example',
    MIMIR_DATA_DIR: '/data',
    MIMIR_HOSTS: 'mimir.example, [::1]',
    MIMIR_PORT: '12345',
    MIMIR_URL: 'https://mimir.example/',
  });
  expect(config).toEqual({
    agent: { enabled: false },
    dataDirectory: '/data',
    gitCredentials: { configured: false },
    port: 12345,
    serve: { hosts: ['mimir.example', '[::1]'], url: 'https://mimir.example' },
    store: { backend: 'postgres', url: 'postgres://user:secret@db/example' },
    t3: { enabled: false },
  });
  for (const [key, value] of Object.entries({
    MIMIR_DATABASE_URL: 'sqlite://db',
    MIMIR_DATABASE_URL_FILE: '/missing-secret',
    MIMIR_DATA_DIR: '',
    MIMIR_HOSTS: 'bad:80',
    MIMIR_PORT: '0',
    MIMIR_URL: 'https://host/path',
  })) {
    // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
    await expect(readHostConfig({ [key]: value })).rejects.toThrow(key);
  }
  // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
  await expect(
    readHostConfig({ MIMIR_DATABASE_URL: '', MIMIR_DATABASE_URL_FILE: 'secret' }),
  ).rejects.toThrow('MIMIR_DATABASE_URL and MIMIR_DATABASE_URL_FILE');
});

test('the data directory is the working directory on Postgres too, with the same default', async () => {
  const postgres = await readHostConfig({ MIMIR_DATABASE_URL: 'postgres://db/example' });
  expect(postgres.dataDirectory).toBe((await readHostConfig({})).dataDirectory);
  expect(
    (await readHostConfig({ MIMIR_DATABASE_URL: 'postgres://db/example', MIMIR_DATA_DIR: '/work' }))
      .dataDirectory,
  ).toBe('/work');
});

test('an unreadable git credentials file degrades instead of refusing startup', async () => {
  expect(
    (await readHostConfig({ MIMIR_GIT_CREDENTIALS_FILE: '/missing-credentials' })).gitCredentials,
  ).toEqual({ configured: true, file: '/missing-credentials', problem: 'unreadable' });
});

test('a mounted secret file selects Postgres and trims its trailing newline', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'host-secret-'));
  try {
    const file = join(root, 'url');
    await writeFile(file, 'postgres://user:secret@db/example\n');
    expect((await readHostConfig({ MIMIR_DATABASE_URL_FILE: file })).store).toEqual({
      backend: 'postgres',
      url: 'postgres://user:secret@db/example',
    });
    await writeFile(file, '');
    // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
    await expect(readHostConfig({ MIMIR_DATABASE_URL_FILE: file })).rejects.toThrow(
      'MIMIR_DATABASE_URL_FILE',
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('host bundles share one validated boot snapshot even if the secret changes', async () => {
  const { hostConfig } = await import('./config');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'host-config-snapshot-'));
  const saved = process.env;
  globalThis.mimirHostConfiguration = undefined;
  try {
    const file = join(root, 'url');
    process.env = { MIMIR_DATABASE_URL_FILE: file };
    await writeFile(file, 'postgres://user:secret@db/example');
    const first = await hostConfig();
    await writeFile(file, 'invalid');
    expect(await hostConfig()).toBe(first);
  } finally {
    process.env = saved;
    globalThis.mimirHostConfiguration = undefined;
    await rm(root, { force: true, recursive: true });
  }
});

test('host accepts the driver-supported Unix socket URL forms', async () => {
  for (const url of [
    'postgres:///db?host=/var/run/postgresql',
    'postgresql://user@/db?host=/run/pg',
  ]) {
    expect((await readHostConfig({ MIMIR_DATABASE_URL: url })).store).toEqual({
      backend: 'postgres',
      url,
    });
  }
});

test('Postgres configuration names its effective endpoint instead of using driver ambient defaults', async () => {
  for (const url of [
    'postgres://',
    'postgres:///db',
    'postgres://u:p@/db',
    'postgres://ho st/db',
  ]) {
    let refusal: unknown;
    try {
      await readHostConfig({ MIMIR_DATABASE_URL: url });
    } catch (error) {
      refusal = error;
    }
    expect(refusal instanceof Error ? refusal.message : '').toContain('MIMIR_DATABASE_URL');
  }
});

const KEY = Buffer.alloc(32, 7).toString('base64');
const T3_READY = {
  MIMIR_HOSTS: 'mimir.example',
  MIMIR_SECRET_KEY: KEY,
  MIMIR_T3_URL: 'https://t3.example/',
  MIMIR_URL: 'https://mimir.example',
};

test('T3 is absent without MIMIR_T3_URL, and the key settings are then ignored', async () => {
  for (const env of [
    {},
    { MIMIR_SECRET_KEY: 'not a key' },
    { MIMIR_SECRET_KEY_FILE: '/missing-key' },
  ]) {
    expect((await readHostConfig(env)).t3).toEqual({ enabled: false });
  }
});

test('setting both secret key variables refuses startup, with or without T3', async () => {
  for (const env of [
    { MIMIR_SECRET_KEY: KEY, MIMIR_SECRET_KEY_FILE: '/key' },
    { ...T3_READY, MIMIR_SECRET_KEY_FILE: '/key' },
  ]) {
    // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
    await expect(readHostConfig(env)).rejects.toThrow(
      'MIMIR_SECRET_KEY and MIMIR_SECRET_KEY_FILE cannot both be set',
    );
  }
});

test('a fully set up T3 carries its normalized origin, the console origin, and the key', async () => {
  const { t3 } = await readHostConfig(T3_READY);
  expect(t3).toMatchObject({
    consoleUrl: 'https://mimir.example',
    enabled: true,
    problems: [],
    url: 'https://t3.example',
  });
  expect(t3.enabled && t3.key).toBeTruthy();
  const loopback = await readHostConfig({
    MIMIR_HOSTS: '',
    MIMIR_SECRET_KEY: KEY,
    MIMIR_T3_URL: 'http://127.0.0.1:3773',
  });
  expect(loopback.t3).toMatchObject({ problems: [], url: 'http://127.0.0.1:3773' });
});

test('each misconfiguration names its setting and degrades instead of refusing startup', async () => {
  const cases: [Record<string, string | undefined>, { setting: string; problem: string }][] = [
    [{ MIMIR_T3_URL: 'https://t3.example/mcp' }, { problem: 'malformed', setting: 'MIMIR_T3_URL' }],
    [{ MIMIR_T3_URL: 'http://t3.example' }, { problem: 'malformed', setting: 'MIMIR_T3_URL' }],
    [{ MIMIR_T3_URL: '' }, { problem: 'malformed', setting: 'MIMIR_T3_URL' }],
    [{ MIMIR_HOSTS: undefined }, { problem: 'unset', setting: 'MIMIR_HOSTS' }],
    [{ MIMIR_SECRET_KEY: undefined }, { problem: 'missing', setting: 'MIMIR_SECRET_KEY' }],
    [{ MIMIR_SECRET_KEY: 'short' }, { problem: 'malformed', setting: 'MIMIR_SECRET_KEY' }],
    [
      { MIMIR_SECRET_KEY: undefined, MIMIR_SECRET_KEY_FILE: '/missing-key' },
      { problem: 'unreadable', setting: 'MIMIR_SECRET_KEY_FILE' },
    ],
    [{ MIMIR_URL: 'http://mimir.example' }, { problem: 'not HTTPS', setting: 'MIMIR_URL' }],
  ];
  for (const [change, problem] of cases) {
    const env = { ...T3_READY, ...change };
    for (const [name, value] of Object.entries(change)) {
      if (value === undefined) {
        delete env[name as keyof typeof env];
      }
    }
    const { t3 } = await readHostConfig(env);
    expect(t3).toMatchObject({ enabled: true, problems: [problem] });
  }
});

test('a key file is read strictly, trimming only surrounding whitespace', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'host-secret-key-'));
  try {
    const file = join(root, 'key');
    const env = { ...T3_READY, MIMIR_SECRET_KEY: undefined, MIMIR_SECRET_KEY_FILE: file };
    await writeFile(file, `${KEY}\n`);
    const usable = (await readHostConfig(env)).t3;
    expect(usable).toMatchObject({ problems: [] });
    expect(usable.enabled && usable.key).toBeTruthy();
    await writeFile(file, 'not a key\n');
    expect((await readHostConfig(env)).t3).toMatchObject({
      key: undefined,
      problems: [{ problem: 'malformed', setting: 'MIMIR_SECRET_KEY_FILE' }],
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('the startup warnings name each setting and problem, never a value', async () => {
  const { t3StartupWarnings } = await import('./t3-settings');
  const { t3 } = await readHostConfig({
    MIMIR_SECRET_KEY: 'c2VjcmV0LXZhbHVl',
    MIMIR_T3_URL: 'https://t3.example/private-path',
  });
  const warnings = t3StartupWarnings(t3);
  expect(warnings).toEqual([
    expect.stringContaining('MIMIR_T3_URL is malformed'),
    expect.stringContaining('MIMIR_HOSTS is unset'),
    expect.stringContaining('MIMIR_SECRET_KEY is malformed'),
  ]);
  expect(warnings.join('\n')).not.toContain('private-path');
  expect(warnings.join('\n')).not.toContain('c2VjcmV0LXZhbHVl');
  expect(t3StartupWarnings((await readHostConfig({})).t3)).toEqual([]);
});
