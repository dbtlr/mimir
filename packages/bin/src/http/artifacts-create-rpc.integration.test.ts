import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Server } from 'bun';

import { createInitiative, createPhase, createProject } from '../core';
import type { Store } from '../core';
import { createTestStore, nodeIdOf, projectIdOf } from '../testing/store';
import { createServer } from './server';

/**
 * The HTTP artifact-create read budget (MMR-283): the 201 body renders from
 * the record `attachArtifact` already holds, so it must pay no follow-up
 * `getArtifact` — no extra working-set load for the (now-redundant)
 * active-project re-check, and no point `load` re-reading the artifact just
 * written. Counted at the store seam, so the budget holds on every backend.
 */
let store: Store;
let closeStore: () => Promise<void>;
let server: Server<undefined>;
let base: string;
let phaseRef: string;

type Rec = Record<string, unknown>;

beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
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
  await closeStore();
});

type ReadCounts = { artifactLoads: number; workingSetLoads: number };

/**
 * Count the store's reads while `fn` runs: whole working-set loads, and artifact
 * point loads (what a `getArtifact` re-read would pay). Restores the store after.
 */
async function countReads(fn: () => Promise<unknown>): Promise<ReadCounts> {
  const counts: ReadCounts = { artifactLoads: 0, workingSetLoads: 0 };
  const loadWorkingSet = store.loadWorkingSet.bind(store);
  const load = store.artifacts.load.bind(store.artifacts);
  store.loadWorkingSet = () => {
    counts.workingSetLoads += 1;
    return loadWorkingSet();
  };
  store.artifacts.load = (...args) => {
    counts.artifactLoads += 1;
    return load(...args);
  };
  try {
    await fn();
  } finally {
    store.loadWorkingSet = loadWorkingSet;
    store.artifacts.load = load;
  }
  return counts;
}

test('POST /api/nodes/:id/artifacts pays no post-create getArtifact (no artifact point-read, MMR-283)', async () => {
  let status = 0;
  let created: Rec = {};
  const counts = await countReads(async () => {
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

  // No point load at all: the 201 body is built from `attachArtifact`'s held
  // record — never a `store.artifacts.load` re-read of the artifact just attached.
  expect(counts.artifactLoads).toBe(0);
  // Two store-level working-set loads remain: the anchor lookup at the top of
  // the handler and `artifactDetailToWire`'s post-write link-title enrichment
  // (`attachArtifact`'s validation reads inside its own transaction) — never a
  // third for the eliminated `getArtifact` active-project re-check (MMR-283).
  expect(counts.workingSetLoads).toBe(2);
});
