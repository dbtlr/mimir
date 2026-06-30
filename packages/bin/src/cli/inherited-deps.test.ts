/**
 * MMR-115 — Inherited dependencies: the dependent's record render surfaces the
 * unsettled effective prerequisites, tagging an inherited one with its `via`
 * ancestor (the self-orienting "what unblocks me?" line).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from '../core';
import type { Db } from '../core';
import { depend } from '../core/mutations';
import { createTestDb } from '../db/testing';
import { runCli } from './run';
import { fakeIo } from './testing';

let db: Db;
let initId: number;
beforeEach(async () => {
  db = await createTestDb();
  const p = await createProject(db, { key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(db, { projectId: p.id, title: 'Init' });
  initId = init.id;
});
afterEach(async () => {
  await db.destroy();
});

test('get renders an inherited prerequisite as an "awaiting on … (via …)" line', async () => {
  const phase1 = await createPhase(db, { parentId: initId, title: 'Phase 1' });
  const phase2 = await createPhase(db, { parentId: initId, title: 'Phase 2' });
  await depend(db, phase2.id, [phase1.id]); // edge on the ancestor phase
  const t = await createTask(db, { parentId: phase2.id, title: 'work' });

  const io = fakeIo(true); // TTY → human record render
  await runCli(['get', `MMR-${String(t.seq)}`], () => db, io);
  const out = io.out.join('');

  expect(out).toContain('awaiting on');
  expect(out).toContain(`via MMR-${String(phase2.seq)}`);
});
