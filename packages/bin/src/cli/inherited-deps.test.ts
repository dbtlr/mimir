/**
 * MMR-115 — Inherited dependencies: the dependent's record render surfaces the
 * unsettled effective prerequisites, tagging an inherited one with its `via`
 * ancestor (the self-orienting "what unblocks me?" line).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  createInitiative,
  createPhase,
  createProject,
  createSqliteStore,
  createTask,
} from '../core';
import type { Db, Store } from '../core';
import { depend } from '../core/mutations';
import { createTestDb } from '../db/testing';
import { runCli } from './run';
import { fakeIo } from './testing';

let db: Db;
let store: Store;
let initId: number;
beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
  const p = await createProject(store, { key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(store, { projectId: p.id, title: 'Init' });
  initId = init.id;
});
afterEach(async () => {
  await db.destroy();
});

test('get renders an inherited prerequisite as an "awaiting on … (via …)" line', async () => {
  const phase1 = await createPhase(store, { parentId: initId, title: 'Phase 1' });
  const phase2 = await createPhase(store, { parentId: initId, title: 'Phase 2' });
  await depend(store, phase2.id, [phase1.id]); // edge on the ancestor phase
  const t = await createTask(store, { parentId: phase2.id, title: 'work' });

  const io = fakeIo(true); // TTY → human record render
  await runCli(['get', `MMR-${String(t.seq)}`], () => store, io);
  const out = io.out.join('');

  expect(out).toContain('awaiting on');
  expect(out).toContain(`via MMR-${String(phase2.seq)}`);
});
