import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
