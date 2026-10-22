import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SandboxError } from './failures';
import { latestSnapshot, snapshotSchema } from './snapshot';
import { Sandbox } from './workflow';

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'unexpected success';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** What `promise` rejected with, or undefined when it resolved. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
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

test('verify, upgrade, and run refuse an unknown sandbox as a sandbox failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-sandbox-test-'));
  const id = '00000000-0000-4000-8000-000000000000';
  try {
    const sandbox = new Sandbox(root);
    for (const operation of [
      () => sandbox.verify(id),
      () => sandbox.upgrade(id, 'dist/mimir'),
      () => sandbox.run(id, ['list']),
    ]) {
      const error = await refusal(operation());
      expect(error).toBeInstanceOf(SandboxError);
      expect((error as Error).message).toBe(`Sandbox ${id} does not exist.`);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('restore refuses a missing configuration or snapshot as a sandbox failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-snapshot-test-'));
  try {
    const sandbox = new Sandbox(root);
    const unconfigured = await refusal(sandbox.restore('capture-1'));
    expect(unconfigured).toBeInstanceOf(SandboxError);
    expect((unconfigured as Error).message).toContain('.dev/sandbox.json');
    await mkdir(join(root, '.dev'));
    await writeFile(
      join(root, '.dev', 'sandbox.json'),
      JSON.stringify({ snapshots: { directory: 'snapshots' } }),
    );
    const noDirectory = await refusal(sandbox.restore('latest'));
    expect(noDirectory).toBeInstanceOf(SandboxError);
    expect((noDirectory as Error).message).toContain('snapshots');
    await mkdir(join(root, 'snapshots'));
    const unknown = await refusal(sandbox.restore('capture-1'));
    expect(unknown).toBeInstanceOf(SandboxError);
    expect((unknown as Error).message).toContain("Snapshot capture-1 doesn't exist");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('host refuses an invalid port or an unowned sandbox before launching a server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-owner-'));
  try {
    const sandbox = new Sandbox(root);
    expect(await failure(sandbox.host('../production'))).toContain('Invalid sandbox ID');
    expect(await failure(sandbox.host('00000000-0000-4000-8000-000000000000'))).toContain(
      'does not exist',
    );
    expect(await failure(sandbox.host('00000000-0000-4000-8000-000000000000', '65536'))).toContain(
      '--port',
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('restore rejects a corrupt archive before allocating a sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-snapshot-test-'));
  try {
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
      'does not match its checksum',
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
    for (const args of [
      ['installation-install', '--mode', 'live'],
      ['self-update'],
      ['--format', 'json', 'self-update'],
    ]) {
      expect(await failure(sandbox.run('00000000-0000-4000-8000-000000000000', args))).toContain(
        'installation machinery is disabled',
      );
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('snapshot manifests require numeric PostgreSQL 18 versions', () => {
  const base = {
    capturedAt: '2026-09-17T00:00:00Z',
    id: 'capture',
    pgDumpVersion: '18.6',
    postgresVersion: '18.6',
    sha256: '0'.repeat(64),
    version: 1,
  };
  expect(snapshotSchema.safeParse(base).success).toBe(true);
  for (const field of ['pgDumpVersion', 'postgresVersion']) {
    for (const value of ['', 'PostgreSQL 18.6', '18.bad', '17.6']) {
      expect(snapshotSchema.safeParse({ ...base, [field]: value }).success).toBe(false);
    }
  }
});
