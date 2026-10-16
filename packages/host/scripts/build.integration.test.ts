/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostRoot = fileURLToPath(new URL('..', import.meta.url));
const viteEntry = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));

test('prerender builds ignore deployment configuration and never open a store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-build-'));
  const data = join(root, 'unused-data');
  const child = Bun.spawn([process.execPath, viteEntry, 'build'], {
    cwd: hostRoot,
    env: {
      ...process.env,
      MIMIR_DATABASE_URL: 'postgres://unused:unused@database.invalid/unused',
      MIMIR_DATABASE_URL_FILE: join(root, 'missing-secret'),
      MIMIR_DATA_DIR: data,
      MIMIR_HOSTS: 'invalid/hostname',
      MIMIR_PORT: 'invalid',
      MIMIR_SANDBOX_AUTHORITY: undefined,
      MIMIR_URL: 'invalid-origin',
      NODE_ENV: 'production',
      TSS_PRERENDERING: undefined,
      VITEST: undefined,
    },
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, `${stdout}\n${stderr}`.slice(-16_000)).toBe(0);
    expect(await Bun.file(join(data, 'store.sqlite')).exists()).toBe(false);
    expect(`${stdout}\n${stderr}`).not.toContain('applied migration');
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await child.exited;
    await rm(root, { force: true, recursive: true });
  }
}, 70_000);
