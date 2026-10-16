import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DatabaseSandboxAuthority } from '../../core/src/sandbox-authority';
import { hostEnvironment, launchHost } from './host';

const authority: DatabaseSandboxAuthority = {
  containerId: 'a'.repeat(64),
  id: '1234abcd-1234-4234-8234-123456789012',
  image: `postgres@sha256:${'b'.repeat(64)}`,
  paths: {
    cache: '/sandbox/cache/mimir',
    config: '/sandbox/config/mimir',
    data: '/sandbox/data/mimir',
  },
  postgresUrl: `postgres://mimir_sandbox:${'c'.repeat(64)}@127.0.0.1:15432/mimir_sandbox`,
  root: '/sandbox',
  version: 1,
};
const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

test('sandbox host selects its owned endpoint and clears ambient host configuration', () => {
  process.env.MIMIR_DATABASE_URL = 'postgres://live/production';
  process.env.MIMIR_DATABASE_URL_FILE = '/secrets/live';
  process.env.MIMIR_HOSTS = 'live.example';
  process.env.MIMIR_PORT = '80';
  process.env.PGHOST = 'live.example';
  const env = hostEnvironment(authority, '6543');
  expect(env.MIMIR_DATABASE_URL).toBe(authority.postgresUrl);
  expect(env.MIMIR_SANDBOX_AUTHORITY).toBe('/sandbox/authority.json');
  expect(env.MIMIR_PORT).toBe('6543');
  expect(env.MIMIR_DATABASE_URL_FILE).toBeUndefined();
  expect(env.MIMIR_HOSTS).toBeUndefined();
  expect(env.PGHOST).toBeUndefined();
});

test('sandbox host runs the development server in the host package with loopback and strict port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-launch-'));
  try {
    const host = join(root, 'packages', 'host');
    await mkdir(host, { recursive: true });
    await writeFile(join(host, 'package.json'), JSON.stringify({ scripts: { dev: 'bun dev.ts' } }));
    await writeFile(
      join(host, 'dev.ts'),
      `await Bun.write('observed.json', JSON.stringify({ args: process.argv.slice(2), url: process.env.MIMIR_DATABASE_URL, authority: process.env.MIMIR_SANDBOX_AUTHORITY }));`,
    );
    await launchHost(root, authority, { port: '6543' });
    expect(JSON.parse(await readFile(join(host, 'observed.json'), 'utf8'))).toEqual({
      args: ['--host', '127.0.0.1', '--port', '6543', '--strictPort'],
      authority: '/sandbox/authority.json',
      url: authority.postgresUrl,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('sandbox host timeout stops descendants and retains the sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-timeout-'));
  try {
    const host = join(root, 'packages', 'host');
    await mkdir(host, { recursive: true });
    await writeFile(join(host, 'package.json'), JSON.stringify({ scripts: { dev: 'bun dev.ts' } }));
    await writeFile(
      join(host, 'dev.ts'),
      `Bun.spawn([process.execPath, '-e', "await Bun.sleep(500); await Bun.write('escaped', 'yes')"], { stdout: 'ignore', stderr: 'ignore' }); await Bun.write('started', 'yes'); await Bun.sleep(10000);`,
    );
    let failure: unknown;
    try {
      await launchHost(root, authority, { timeout: 200 });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error && failure.message).toContain('timed out');
    expect(await Bun.file(join(host, 'started')).text()).toBe('yes');
    await Bun.sleep(600);
    expect(await Bun.file(join(host, 'escaped')).exists()).toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
