/**
 * MMR-115 — Inherited dependencies: the dependent's record render surfaces the
 * unsettled effective prerequisites, tagging an inherited one with its `via`
 * ancestor (the self-orienting "what unblocks me?" line).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from '../core';
import type { Store } from '../core';
import { depend } from '../core/mutations';
import { createTestStore, nodeIdOf, projectIdOf } from '../testing/store';
import { runCli } from './run';
import { fakeIo } from './testing';

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: () => Promise<void>;
let initId: number;
beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(store, {
    projectId: await projectIdOf(store, 'MMR'),
    title: 'Init',
  });
  initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
});
afterEach(async () => {
  await closeStore();
});

test.skipIf(!NORN)(
  'get renders an inherited prerequisite as an "awaiting on … (via …)" line',
  async () => {
    const phase1 = await createPhase(store, { parentId: initId, title: 'Phase 1' });
    const phase2Raw = await createPhase(store, { parentId: initId, title: 'Phase 2' });
    const phase1Id = await nodeIdOf(store, `MMR-${String(phase1.seq)}`);
    const phase2 = await nodeIdOf(store, `MMR-${String(phase2Raw.seq)}`);
    await depend(store, phase2, [phase1Id]); // edge on the ancestor phase
    const t = await createTask(store, { parentId: phase2, title: 'work' });

    const io = fakeIo(true); // TTY → human record render
    await runCli(['get', `MMR-${String(t.seq)}`], () => store, io);
    const out = io.out.join('');

    expect(out).toContain('awaiting on');
    expect(out).toContain(`via MMR-${String(phase2Raw.seq)}`);
  },
);
