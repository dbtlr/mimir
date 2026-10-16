import { expect, test } from 'bun:test';

import { readHostConfig } from './config';

test('host defaults select isolated SQLite and the standard port', async () => {
  expect(await readHostConfig({})).toEqual({
    dataDirectory: expect.stringContaining('.dev/host'),
    port: 64647,
    serve: {},
    store: { backend: 'sqlite' },
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
    dataDirectory: '/data',
    port: 12345,
    serve: { hosts: ['mimir.example', '[::1]'], url: 'https://mimir.example' },
    store: { backend: 'postgres', url: 'postgres://user:secret@db/example' },
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
