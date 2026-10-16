import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openHost } from './host';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test('host migrates a named SQLite directory and preserves writes after reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-host-'));
  roots.push(root);
  const directory = join(root, 'data');
  const host = await openHost(directory, 'host-test');
  try {
    const health = await host.handle(new Request('http://localhost/api/health'));
    expect(await health.json()).toMatchObject({ status: 'ok', version: 'host-test' });
    const create = await host.handle(
      new Request('http://localhost/api/projects', {
        body: JSON.stringify({ key: 'TST', name: 'Disposable container project' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(create.status).toBe(201);
  } finally {
    await host.close();
  }
  const reopened = await openHost(directory, 'host-test');
  try {
    const projects = await reopened.handle(new Request('http://localhost/api/projects'));
    expect(await projects.json()).toMatchObject({
      items: [{ id: 'TST', title: 'Disposable container project' }],
    });
  } finally {
    await reopened.close();
  }
});
