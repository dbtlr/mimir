import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Server } from 'bun';

import { createInitiative, createPhase, createProject } from '../core';
import type { Store } from '../core';
import { bunExec } from '../exec';
import { NornClient } from '../norn/client';
import { createNornWriteStore } from '../norn/writer';
import { nodeIdOf, projectIdOf } from '../testing/store';
import { converge } from '../vault/converge';
import { createServer } from './server';

/**
 * The HTTP artifact-create RPC budget (MMR-283): the 201 body renders from
 * the record `attachArtifact` already holds, so it must pay no follow-up
 * `getArtifact` — no extra whole-vault find for the (now-redundant)
 * active-project re-check, and no point `get` re-reading the artifact just
 * written. Baseline (pre-fix), measured with this same harness: `gets: 1,
 * wholeVaultFinds: 4` — `getArtifact` cost one point read plus one whole-vault
 * find. Uses a directly-constructed `NornClient` (rather than
 * `testing/store`'s `createTestStore`) so the RPCs it issues can be
 * instrumented. Needs `norn`; skipped when off PATH.
 */
const NORN = Bun.which('norn') !== null;

let root: string;
let client: NornClient;
let store: Store;
let server: Server<undefined>;
let base: string;
let phaseRef: string;

type Rec = Record<string, unknown>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mimir-httpartrpc-'));
  const vault = join(root, 'vault');
  await converge(vault, { allowCreate: true, exec: bunExec });
  client = new NornClient({ vaultPath: vault });
  store = createNornWriteStore(client, vault);
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  const projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'init' });
  const initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'phase' });
  phaseRef = `MMR-${String(phase.seq)}`;
  server = createServer(store, { hunt: false, port: 0, version: 'test' });
  base = `http://127.0.0.1:${String(server.port)}`;
});

afterEach(async () => {
  await server.stop(true);
  await client.close();
  rmSync(root, { force: true, recursive: true });
});

type RpcCounts = { finds: number; wholeVaultFinds: number; gets: number };

/**
 * Instrument the norn client's read RPCs (mirrors MMR-251's `countRpcs` in
 * `core/seeds/intent.integration.test.ts`): total `vault.find`s, the
 * whole-vault subset (`type:project,task,phase,initiative` — what
 * `loadWorkingSet` pays), and `vault.get`s (point + section reads — what a
 * `store.artifacts.load` re-read would pay).
 */
async function countRpcs(fn: () => Promise<unknown>): Promise<RpcCounts> {
  const counts: RpcCounts = { finds: 0, gets: 0, wholeVaultFinds: 0 };
  const find = client.find.bind(client);
  const get = client.get.bind(client);
  client.find = (args) => {
    counts.finds += 1;
    if ((args.in ?? []).some((s) => s.includes('type:project,task,phase,initiative'))) {
      counts.wholeVaultFinds += 1;
    }
    return find(args);
  };
  client.get = (targets, col) => {
    counts.gets += 1;
    return get(targets, col);
  };
  try {
    await fn();
  } finally {
    client.find = find;
    client.get = get;
  }
  return counts;
}

test.skipIf(!NORN)(
  'POST /api/nodes/:id/artifacts pays no post-create getArtifact (no artifact point-read, MMR-283)',
  async () => {
    let status = 0;
    let created: Rec = {};
    const counts = await countRpcs(async () => {
      const res = await fetch(`${base}/api/nodes/${phaseRef}/artifacts`, {
        body: JSON.stringify({ content: 'body', title: 'held-record echo' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      status = res.status;
      created = (await res.json()) as Rec;
    });
    expect(status).toBe(201);
    expect(created.id).toBe('MMR-a1');

    // No point `get` at all: the artifact write is a `create_document` apply,
    // and the 201 body is built from `attachArtifact`'s held record — never a
    // `store.artifacts.load` re-read of the artifact just attached.
    expect(counts.gets).toBe(0);
    // Three whole-vault finds remain (all pre-existing and out of this
    // refactor's scope): the anchor lookup at the top of the handler, the
    // pre-write link/project-validation transaction inside `attachArtifact`,
    // and `artifactDetailToWire`'s post-write link-title enrichment — never a
    // FOURTH for the now-eliminated `getArtifact` active-project re-check that
    // used to follow the write (MMR-283).
    expect(counts.wholeVaultFinds).toBe(3);
  },
);
