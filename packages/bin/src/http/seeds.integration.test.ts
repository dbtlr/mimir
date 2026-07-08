import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Server } from 'bun';

import {
  createInitiative,
  createPhase,
  createProject,
  deriveSet,
  findNodeInSet,
  resolveProjectKeyInSet,
} from '../core';
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

  test('promote echoes the created task id as a sibling field (B7)', async () => {
    // A phase to promote under.
    const pid = resolveProjectKeyInSet(deriveSet(await store.loadWorkingSet()), 'MMR');
    const init = await createInitiative(store, { projectId: pid, title: 'init' });
    const afterInit = deriveSet(await store.loadWorkingSet());
    const initNode = findNodeInSet(afterInit, `MMR-${String(init.seq)}`);
    if (initNode === undefined) {
      throw new Error('init not found');
    }
    const phase = await createPhase(store, { parentId: initNode.id, title: 'phase' });
    await fetch(`${base}/api/seeds`, {
      body: JSON.stringify({ kind: 'feature', project: 'MMR', title: 's' }),
      method: 'POST',
    });
    const res = await fetch(`${base}/api/seeds/MMR-s1/promote`, {
      body: JSON.stringify({ parent: `MMR-${String(phase.seq)}` }),
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const rec = (await res.json()) as Rec;
    expect(rec).toMatchObject({ id: 'MMR-s1', lifecycle: 'promoted' });
    expect(rec.created).toMatch(/^MMR-\d+$/); // the spawned task id, sibling of the seed wire
  });

  test('?project=all lists every active board; empty ?requester= is no filter (B5b/c)', async () => {
    await createProject(store, { key: 'OTH', name: 'Other' });
    await fetch(`${base}/api/seeds`, {
      body: JSON.stringify({ kind: 'idea', project: 'MMR', title: 'a' }),
      method: 'POST',
    });
    await fetch(`${base}/api/seeds`, {
      body: JSON.stringify({ kind: 'bug', project: 'OTH', title: 'b' }),
      method: 'POST',
    });
    const all = (await (await fetch(`${base}/api/seeds?project=all`)).json()) as {
      items: Rec[];
      total: number;
    };
    expect(all.items.map((s) => String(s.id)).toSorted()).toEqual(['MMR-s1', 'OTH-s1']);
    // An empty requester filter is absent, not a filter for '' → the whole queue.
    const q = (await (await fetch(`${base}/api/seeds?requester=`)).json()) as { total: number };
    expect(q.total).toBe(2);
  });

  test('POST requester:"" stores null (frontmatter-absent), never [[]] (B5c)', async () => {
    const rec = (await (
      await fetch(`${base}/api/seeds`, {
        body: JSON.stringify({ kind: 'idea', project: 'MMR', requester: '', title: 'x' }),
        method: 'POST',
      })
    ).json()) as Rec;
    expect(rec.requester).toBeNull();
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
