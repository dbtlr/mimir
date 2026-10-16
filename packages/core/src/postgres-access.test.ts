import { expect, test } from 'bun:test';

import { openPostgres } from './store-postgres/client';

test('an uninstalled source process refuses Postgres before creating a pool', () => {
  const saved = process.env.MIMIR_SANDBOX_AUTHORITY;
  delete process.env.MIMIR_SANDBOX_AUTHORITY;
  let pools = 0;
  try {
    expect(() =>
      openPostgres('postgres://live:secret@production.invalid/live', {
        createPool: () => {
          pools++;
          throw new Error('Pool creation must not occur');
        },
      }),
    ).toThrow('registered live installation or a launcher-owned sandbox');
    expect(pools).toBe(0);
  } finally {
    if (saved === undefined) {
      delete process.env.MIMIR_SANDBOX_AUTHORITY;
    } else {
      process.env.MIMIR_SANDBOX_AUTHORITY = saved;
    }
  }
});

test('an environment variable cannot grant image authority to a source process', () => {
  const saved = process.env.MIMIR_HOST_AUTHORITY;
  process.env.MIMIR_HOST_AUTHORITY = 'true';
  const sandbox = process.env.MIMIR_SANDBOX_AUTHORITY;
  delete process.env.MIMIR_SANDBOX_AUTHORITY;
  try {
    expect(() => openPostgres('postgres://live:secret@production.invalid/live')).toThrow(
      'registered live installation',
    );
  } finally {
    if (saved === undefined) {
      delete process.env.MIMIR_HOST_AUTHORITY;
    } else {
      process.env.MIMIR_HOST_AUTHORITY = saved;
    }
    if (sandbox !== undefined) {
      process.env.MIMIR_SANDBOX_AUTHORITY = sandbox;
    }
  }
});

test('only the compiled image constant admits the host before pool construction', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'host-authority-'));
  try {
    const entry = join(root, 'entry.ts');
    const client = new URL('store-postgres/client.ts', import.meta.url).pathname;
    await writeFile(
      entry,
      `import { openPostgres } from ${JSON.stringify(client)};\ntry { openPostgres('postgres://user:secret@production.invalid/db', { createPool: () => { throw new Error('pool admitted'); } }); } catch (error) { console.error(error.message); process.exit(error.message === 'pool admitted' ? 0 : 1); }`,
    );
    const built = await Bun.build({
      define: { MIMIR_HOST_AUTHORITY: 'true' },
      entrypoints: [entry],
      naming: 'image.mjs',
      outdir: root,
      target: 'bun',
    });
    expect(built.success).toBe(true);
    const child = Bun.spawn([process.execPath, join(root, 'image.mjs')], {
      stderr: 'pipe',
      stdout: 'pipe',
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toContain('pool admitted');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
