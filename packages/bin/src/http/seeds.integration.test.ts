import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Server } from 'bun';

import { createProject } from '../core';
import type { Store } from '../core';
import { bunExec } from '../exec';
import { NornClient } from '../norn/client';
import { createNornWriteStore } from '../norn/writer';
import { converge } from '../vault/converge';
import { createServer } from './server';

/** The /api/seeds resource (MMR-245) end-to-end over a real Norn store. Needs `norn`. */
const NORN = Bun.which('norn') !== null;

let root: string;
let client: NornClient;
let store: Store;
let server: Server<undefined>;
let base: string;

type Rec = Record<string, unknown>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mimir-httpseed-'));
  const vault = join(root, 'vault');
  await converge(vault, { allowCreate: true, exec: bunExec });
  client = new NornClient({ vaultPath: vault });
  store = createNornWriteStore(client, vault);
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  server = createServer(store, { hunt: false, port: 0, version: 'test' });
  base = `http://127.0.0.1:${String(server.port)}`;
});

afterEach(async () => {
  await server.stop(true);
  await client.close();
  rmSync(root, { force: true, recursive: true });
});

describe.skipIf(!NORN)('/api/seeds', () => {
  test('POST creates a seed and echoes the full wire record', async () => {
    const res = await fetch(`${base}/api/seeds`, {
      body: JSON.stringify({ description: 'prose', kind: 'bug', project: 'MMR', title: 'flaky' }),
      method: 'POST',
    });
    expect(res.status).toBe(201);
    const rec = (await res.json()) as Rec;
    expect(rec).toMatchObject({
      description: 'prose',
      id: 'MMR-s1',
      kind: 'bug',
      lifecycle: 'new',
      project: 'MMR',
      ready_to_resolve: false,
      requester: null,
    });
  });

  test('GET lists the queue; GET/:id resolves one; PATCH patches a live seed', async () => {
    await fetch(`${base}/api/seeds`, {
      body: JSON.stringify({ kind: 'idea', project: 'MMR', title: 'a' }),
      method: 'POST',
    });
    const list = (await (await fetch(`${base}/api/seeds`)).json()) as {
      items: Rec[];
      total: number;
    };
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ id: 'MMR-s1' });

    const one = (await (await fetch(`${base}/api/seeds/MMR-s1`)).json()) as Rec;
    expect(one).toMatchObject({ id: 'MMR-s1', kind: 'idea' });

    const patched = (await (
      await fetch(`${base}/api/seeds/MMR-s1`, {
        body: JSON.stringify({ kind: 'feature', title: 'renamed' }),
        method: 'PATCH',
      })
    ).json()) as Rec;
    expect(patched).toMatchObject({ kind: 'feature', title: 'renamed' });
  });

  test('reject/resolve verb endpoints transition the seed (reason required)', async () => {
    await fetch(`${base}/api/seeds`, {
      body: JSON.stringify({ kind: 'idea', project: 'MMR', title: 'a' }),
      method: 'POST',
    });
    const missing = await fetch(`${base}/api/seeds/MMR-s1/reject`, {
      body: JSON.stringify({}),
      method: 'POST',
    });
    expect(missing.status).toBe(400);
    const resolved = (await (
      await fetch(`${base}/api/seeds/MMR-s1/resolve`, {
        body: JSON.stringify({ reason: 'already fixed' }),
        method: 'POST',
      })
    ).json()) as Rec;
    expect(resolved).toMatchObject({ id: 'MMR-s1', lifecycle: 'resolved' });
  });

  test('POST with an invalid kind is a validation error (400)', async () => {
    const res = await fetch(`${base}/api/seeds`, {
      body: JSON.stringify({ kind: 'chore', project: 'MMR', title: 'x' }),
      method: 'POST',
    });
    expect(res.status).toBe(400);
    const rec = (await res.json()) as { error: { message: string } };
    expect(rec.error.message).toMatch(/invalid kind/);
  });
});
