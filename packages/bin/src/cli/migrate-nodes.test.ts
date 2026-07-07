import { beforeEach, expect, test } from 'bun:test';

import { createInitiative, createProject, createSqliteStore, createTask } from '../core';
import type { Db, Store } from '../core';
import {
  parseAnnotationsSection,
  parseHistorySection,
  sliceBodySection,
} from '../core/history-codec';
import { annotate } from '../core/mutations/data';
import { startTask } from '../core/mutations/lifecycle';
import { createTestDb } from '../db/testing';
import type { NornClient } from '../norn/client';
import { buildSeedDocs } from '../vault/node-seed';
import type { SeedDoc } from '../vault/node-seed';
import { migrateNodes, reconstructNodeBodies, restoreNodeDoc } from './migrate-nodes';
import type { NodeRestore } from './migrate-nodes';

let db: Db;
let store: Store;
beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
});

test('reconstructs a node body with its history + annotations from SQLite rows', async () => {
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, { projectId: p.id, title: 'i' });
  const task = await createTask(store, { parentId: init.id, title: 'a task' });
  await startTask(store, task.id); // a lifecycle transition → transition_log
  await annotate(store, task.id, 'first note');
  await annotate(store, task.id, 'second note');

  const ws = await store.loadWorkingSet();
  const { nodes } = buildSeedDocs(ws, await reconstructNodeBodies(db));
  const doc = nodes.find((d) => d.path === `MMR/MMR-${String(task.seq)}.md`);
  if (doc === undefined) {
    throw new Error('migrated task doc not found');
  }
  // the reconstructed body reads back to the exact records through the read path
  const history = parseHistorySection(sliceBodySection(doc.body, 'History'));
  expect(history.map((h) => `${h.from} → ${h.to}`)).toEqual(['todo → in_progress']);
  expect(
    parseAnnotationsSection(sliceBodySection(doc.body, 'Annotations')).map((a) => a.content),
  ).toEqual(['first note', 'second note']);
});

test('a node with no history/annotations reconstructs the empty-seeded body', async () => {
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, { projectId: p.id, title: 'i' });
  await createTask(store, { parentId: init.id, title: 'untouched' });

  const ws = await store.loadWorkingSet();
  const { nodes } = buildSeedDocs(ws, await reconstructNodeBodies(db));
  expect(parseHistorySection(sliceBodySection(nodes[0]?.body ?? '', 'History'))).toEqual([]);
  expect(parseAnnotationsSection(sliceBodySection(nodes[0]?.body ?? '', 'Annotations'))).toEqual(
    [],
  );
});

const doc = (path: string): SeedDoc => ({ body: '', frontmatter: {}, path });

/** A restore that must never run — the dry-run path writes nothing. */
const neverRestore: NodeRestore = () => {
  throw new Error('dry run must not write');
};

test('migrateNodes tallies created vs skipped, projects before nodes', async () => {
  const seen = new Set<string>();
  const restore: (d: SeedDoc) => Promise<'created' | 'skipped'> = (d) => {
    const outcome = seen.has(d.path) ? 'skipped' : 'created';
    seen.add(d.path);
    return Promise.resolve(outcome);
  };
  const docs = { nodes: [doc('MMR/MMR-1.md')], projects: [doc('MMR/MMR.md')] };

  const first = await migrateNodes(docs, restore);
  expect(first).toMatchObject({ created: 2, nodes: 1, projects: 1, skipped: 0 });
  // a second run over the same vault is idempotent — everything skips
  const second = await migrateNodes(docs, restore);
  expect(second).toMatchObject({ created: 0, skipped: 2 });
});

test('restoreNodeDoc skips a re-run whose on-disk doc was re-saved with CRLF', async () => {
  // A prior migration's doc, re-saved by a Windows editor / git autocrlf, comes
  // back with interior CRLF. `trimEnd` only strips the trailing edge, so a raw
  // byte compare would read it as diverged and rethrow the collision (MMR-172).
  const body = '## History\n\n### 2026-01-01 · started\n\ntodo → in_progress\n';
  const seed: SeedDoc = { body, frontmatter: {}, path: 'MMR/MMR-1.md' };
  const client = {
    get: (): Promise<unknown[]> => Promise.resolve([{ body: body.replace(/\n/g, '\r\n') }]),
    newDoc: (): Promise<unknown> => Promise.reject(new Error('path already exists')),
  } as unknown as NornClient;

  expect(await restoreNodeDoc(client)(seed)).toBe('skipped');
});

test('a dry run counts the inventory and never calls restore', async () => {
  const docs = { nodes: [doc('MMR/MMR-1.md'), doc('MMR/MMR-2.md')], projects: [doc('MMR/MMR.md')] };
  expect(await migrateNodes(docs, neverRestore, { dryRun: true })).toMatchObject({
    created: 0,
    dryRun: true,
    nodes: 2,
    projects: 1,
    skipped: 0,
  });
});
