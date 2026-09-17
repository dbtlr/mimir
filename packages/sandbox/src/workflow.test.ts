import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { latestSnapshot } from './snapshot';
import { Sandbox } from './workflow';

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'unexpected success';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test('destroy rejects an unowned sandbox without calling Docker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-sandbox-test-'));
  try {
    const sandbox = new Sandbox(root);
    expect(await failure(sandbox.destroy('../production'))).toContain('Invalid sandbox ID');
    expect(await failure(sandbox.destroy('00000000-0000-4000-8000-000000000000'))).toContain(
      'does not exist',
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('restore rejects a corrupt archive before allocating a sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-snapshot-test-'));
  try {
    const { mkdir, writeFile, readdir } = await import('node:fs/promises');
    await mkdir(join(root, '.dev'));
    await mkdir(join(root, 'snapshots', 'capture-1'), { recursive: true });
    await writeFile(
      join(root, '.dev', 'sandbox.json'),
      JSON.stringify({ snapshots: { directory: 'snapshots' } }),
    );
    await writeFile(
      join(root, 'snapshots', 'capture-1', 'snapshot.json'),
      JSON.stringify({
        capturedAt: '2026-09-17T00:00:00Z',
        id: 'capture-1',
        pgDumpVersion: '18.6',
        postgresVersion: '18.6',
        sha256: '0'.repeat(64),
        version: 1,
      }),
    );
    await writeFile(join(root, 'snapshots', 'capture-1', 'database.dump'), 'PGDMPcorrupt');
    expect(await failure(new Sandbox(root).restore('capture-1'))).toContain(
      'Snapshot checksum mismatch',
    );
    expect(await readdir(join(root, '.dev'))).toEqual(['sandbox.json']);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('latest resolves timestamps numerically when fractional precision differs', () => {
  const base = {
    pgDumpVersion: '18.6',
    postgresVersion: '18.6',
    sha256: '0'.repeat(64),
    version: 1 as const,
  };
  expect(
    latestSnapshot([
      { ...base, capturedAt: '2026-09-17T00:00:00Z', id: 'earlier' },
      { ...base, capturedAt: '2026-09-17T00:00:00.999Z', id: 'later' },
    ]).id,
  ).toBe('later');
});

test('latest preserves submillisecond precision and uses stable IDs for equal instants', () => {
  const base = {
    pgDumpVersion: '18.6',
    postgresVersion: '18.6',
    sha256: '0'.repeat(64),
    version: 1 as const,
  };
  expect(
    latestSnapshot([
      { ...base, capturedAt: '2026-09-17T00:00:00.123001Z', id: 'a-earlier' },
      { ...base, capturedAt: '2026-09-17T00:00:00.123999Z', id: 'z-later' },
    ]).id,
  ).toBe('z-later');
  expect(
    latestSnapshot([
      { ...base, capturedAt: '2026-09-17T00:00:00.1230Z', id: 'z' },
      { ...base, capturedAt: '2026-09-17T00:00:00.123Z', id: 'a' },
    ]).id,
  ).toBe('a');
});

test('sandbox run refuses installation machinery before opening a sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-run-test-'));
  try {
    const sandbox = new Sandbox(root);
    expect(await failure(sandbox.run('00000000-0000-4000-8000-000000000000', ['serve']))).toContain(
      'finite CLI commands',
    );
    for (const args of [
      ['installation-install', '--mode', 'live'],
      ['self-update'],
      ['setup'],
      ['service', 'install'],
      ['--format', 'json', 'service', 'install'],
    ]) {
      expect(await failure(sandbox.run('00000000-0000-4000-8000-000000000000', args))).toContain(
        'installation and service machinery is disabled',
      );
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
