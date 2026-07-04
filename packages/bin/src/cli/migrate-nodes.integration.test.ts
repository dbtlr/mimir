import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInitiative, createProject, createSqliteStore, createTask } from '../core';
import type { Db, Store } from '../core';
import { annotate } from '../core/mutations/data';
import { completeTask, startTask } from '../core/mutations/lifecycle';
import { createTestDb } from '../db/testing';
import { bunExec } from '../exec';
import { NornClient } from '../norn/client';
import { createNornWriteStore } from '../norn/writer';
import { converge } from '../vault/converge';
import { buildSeedDocs } from '../vault/node-seed';
import { migrateNodes, reconstructNodeBodies, restoreNodeDoc } from './migrate-nodes';

/**
 * The authoritative migration end-to-end (MMR-155), gated on a real `norn`: seed
 * a SQLite store, migrate it into a fresh vault through the live write, then read
 * it back over Norn and assert the projection is lossless — frontmatter
 * (created_at preserved), `## History`, and `## Annotations` all survive — and a
 * re-run is idempotent.
 */
const NORN = Bun.which('norn') !== null;

let root: string;
let client: NornClient;
let db: Db;
let sqlite: Store;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mimir-migrate-'));
  await converge(join(root, 'vault'), { allowCreate: true, exec: bunExec });
  client = new NornClient({ vaultPath: join(root, 'vault') });
  db = await createTestDb();
  sqlite = createSqliteStore(db);
});
afterEach(async () => {
  await client.close();
  await db.destroy();
  rmSync(root, { force: true, recursive: true });
});

async function migrate(): Promise<{ created: number; skipped: number }> {
  const docs = buildSeedDocs(await sqlite.loadWorkingSet(), await reconstructNodeBodies(db));
  return migrateNodes(docs, restoreNodeDoc(client));
}

test.skipIf(!NORN)('migrates node state losslessly and re-runs idempotently', async () => {
  const p = await createProject(sqlite, { key: 'MMR', name: 'm' });
  const init = await createInitiative(sqlite, { projectId: p.id, title: 'i' });
  const task = await createTask(sqlite, { parentId: init.id, title: 'a task' });
  await startTask(sqlite, task.id);
  await annotate(sqlite, task.id, 'first note');
  await annotate(sqlite, task.id, 'second note');
  await completeTask(sqlite, task.id);

  // capture the source created_at to prove the migration preserves it (not now())
  const before = (await sqlite.loadWorkingSet()).nodes.find((n) => n.id === task.id);
  const stem = `MMR-${String(task.seq)}`;

  const first = await migrate();
  expect(first).toMatchObject({ created: 3, skipped: 0 }); // project + initiative + task

  // read the migrated state back over Norn
  const norn = createNornWriteStore(client, join(root, 'vault'));
  const migrated = (await norn.loadWorkingSet()).nodes.find((n) => n.seq === task.seq);
  expect(migrated?.title).toBe('a task');
  expect(migrated?.created_at).toBe(before?.created_at); // created_at preserved
  expect(migrated?.lifecycle).toBe('done');

  const history = await norn.bodySections.readHistory(migrated?.id ?? 0, stem);
  expect(history.map((h) => `${h.from} → ${h.to}`)).toEqual([
    'todo → in_progress',
    'in_progress → done',
  ]);
  const annotations = await norn.bodySections.readAnnotations(migrated?.id ?? 0, stem);
  expect(annotations.map((a) => a.content)).toEqual(['first note', 'second note']);

  // a second migration over the same vault writes nothing
  const second = await migrate();
  expect(second).toMatchObject({ created: 0, skipped: 3 });

  // but a doc whose SOURCE diverged (a new annotation) has a different
  // reconstructed body — it must surface as a conflict, never be silently
  // skipped as "already present" (the fingerprint-blindness the review caught)
  await annotate(sqlite, task.id, 'added after the first migration');
  let conflicted = false;
  try {
    await migrate();
  } catch {
    conflicted = true;
  }
  expect(conflicted).toBe(true);
});
