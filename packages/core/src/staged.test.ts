import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from './create';
import { childDistribution, deriveSet, isInFlightWord, nodeStatusWord } from './derive';
import { MimirError } from './errors';
import { nextTasks } from './intent';
import {
  abandonTask,
  blockTask,
  completeTask,
  depend,
  queueTask,
  reopenTask,
  returnTask,
  stageTask,
  startTask,
  submitTask,
  unblockTask,
} from './mutations';
import { isStale } from './predicates';
import { isRankable } from './rank';
import { interpret, taskStatus } from './status';
import type { Store } from './store';
import { createTestStore, nodeIdOf, projectIdOf } from './testing/store';

/**
 * MMR-675 — the `staged` lifecycle between `under_review` and `done`: reviewed
 * work accepted on its branch but not yet on `main`. `stage` moves only
 * under_review → staged; `return`, `done`, and `abandon` leave it.
 */

let store: Store;
let closeStore: () => Promise<void>;
let phaseId: string;
beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'm' });
  const projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'i' });
  const initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'ph' });
  phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
});
afterEach(async () => {
  await closeStore();
});

const setOf = async () => deriveSet(await store.loadWorkingSet());
const load = async (id: string) => store.transact((w) => w.loadNode(id));

async function todoTask(title = 't'): Promise<string> {
  const t = await createTask(store, { parentId: phaseId, title });
  return nodeIdOf(store, `MMR-${String(t.seq)}`);
}

async function reviewedTask(title = 't'): Promise<string> {
  const id = await todoTask(title);
  await startTask(store, id, { branch: 'feat/x', harness: 'claude', session: 's-1' });
  await submitTask(store, id);
  return id;
}

async function stagedTask(title = 't'): Promise<string> {
  const id = await reviewedTask(title);
  await stageTask(store, id);
  return id;
}

test('a task walks todo → in_progress → under_review → staged → done', async () => {
  const id = await todoTask();
  await startTask(store, id);
  await submitTask(store, id);
  await stageTask(store, id);
  expect((await load(id))?.lifecycle).toBe('staged');
  await completeTask(store, id);
  expect((await load(id))?.lifecycle).toBe('done');
  const { items } = await store.transitions.list();
  const moves = items.filter((t) => t.kind === 'lifecycle').map((t) => `${t.from}>${t.to}`);
  expect(moves).toEqual([
    'todo>in_progress',
    'in_progress>under_review',
    'under_review>staged',
    'staged>done',
  ]);
});

test('stage clears rank, keeps every owner handle, and reads as staged', async () => {
  const id = await todoTask();
  await startTask(store, id, {
    branch: 'feat/x',
    harness: 'claude',
    host: 'h',
    session: 's-1',
    workerHarness: 'codex',
    workerSession: 'w-1',
  });
  await submitTask(store, id);
  await stageTask(store, id);
  const node = await load(id);
  expect(node).toMatchObject({
    branch: 'feat/x',
    harness: 'claude',
    host: 'h',
    lifecycle: 'staged',
    rank: null,
    session: 's-1',
    worker_harness: 'codex',
    worker_session: 'w-1',
  });
  expect(nodeStatusWord(await setOf(), node!)).toBe('staged');
});

test('stage is refused outside under_review; only unsubmitted work is pointed at submit', async () => {
  const todo = await todoTask('a');
  const started = await todoTask('b');
  await startTask(store, started);
  const queued = await todoTask('c');
  await queueTask(store, queued, { session: 'run' });
  const done = await todoTask('d');
  await completeTask(store, done);
  const abandoned = await todoTask('e');
  await abandonTask(store, abandoned);
  const already = await stagedTask('f');
  const refusal = async (id: string): Promise<MimirError> => {
    const error = await stageTask(store, id).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MimirError);
    expect((error as MimirError).code).toBe('validation');
    expect((error as MimirError).message).toContain('only an under_review task can be staged');
    return error as MimirError;
  };
  for (const id of [todo, started, queued]) {
    expect((await refusal(id)).hint).toContain('submit');
  }
  for (const id of [done, abandoned, already]) {
    expect((await refusal(id)).hint).toBeUndefined();
  }
});

test('stage ignores a hold, like submit', async () => {
  const id = await reviewedTask();
  await blockTask(store, id, 'waiting');
  await stageTask(store, id);
  expect((await load(id))?.lifecycle).toBe('staged');
});

test('return sends a staged task back, re-ranking it and logging staged as the source', async () => {
  const id = await stagedTask();
  await returnTask(store, id, 'main moved');
  const node = await load(id);
  expect(node?.lifecycle).toBe('in_progress');
  expect(node?.rank).not.toBeNull();
  const { items } = await store.transitions.list();
  const log = items.find((t) => t.from === 'staged' && t.to === 'in_progress');
  expect(log?.reason).toBe('main moved');
});

test('done completes a staged task, logging staged as the source', async () => {
  const id = await stagedTask();
  await completeTask(store, id);
  const { items } = await store.transitions.list();
  expect(items.find((t) => t.to === 'done')?.from).toBe('staged');
});

test('a staged task can be abandoned and a done one reopened', async () => {
  const id = await stagedTask();
  await abandonTask(store, id, 'dropped');
  expect((await load(id))?.lifecycle).toBe('abandoned');
  await reopenTask(store, id);
  expect((await load(id))?.lifecycle).toBe('in_progress');
});

test('holding a staged task and releasing it does not make it rankable', async () => {
  const id = await stagedTask();
  await blockTask(store, id, 'ci down');
  expect(nodeStatusWord(await setOf(), (await load(id))!)).toBe('blocked');
  await unblockTask(store, id);
  const node = await load(id);
  expect(node?.lifecycle).toBe('staged');
  expect(node?.rank).toBeNull();
  expect(isRankable('staged', 'none')).toBe(false);
});

test('a staged task is absent from next', async () => {
  const id = await stagedTask();
  const ready = await todoTask('ready one');
  const { items } = await nextTasks(store, { scope: 'MMR' });
  const ids = items.map((i) => i.id);
  expect(ids).toContain(`MMR-${String((await load(ready))?.seq)}`);
  expect(ids).not.toContain(`MMR-${String((await load(id))?.seq)}`);
});

test('a dependent of a staged prerequisite still reads awaiting', async () => {
  const prereq = await stagedTask('prereq');
  const dependent = await todoTask('dependent');
  await depend(store, dependent, [prereq]);
  expect(nodeStatusWord(await setOf(), (await load(dependent))!)).toBe('awaiting');
});

test('stage stamps the task, so stale counts from the stage, not the submit', async () => {
  const id = await todoTask();
  try {
    setSystemTime(new Date('2026-10-01T09:00:00Z'));
    await startTask(store, id);
    await submitTask(store, id);
    setSystemTime(new Date('2026-10-20T09:00:00Z'));
    await stageTask(store, id);
  } finally {
    setSystemTime();
  }
  expect((await load(id))?.updated_at).toBe('2026-10-20T09:00:00.000Z');
});

test('stale chases a staged task left too long', async () => {
  const id = await stagedTask();
  const node = await load(id);
  const future = new Date(Date.parse(node!.updated_at) + 30 * 24 * 60 * 60 * 1000).toISOString();
  expect(isStale(await setOf(), node!, { asOf: future })).toBe(true);
  expect(isStale(await setOf(), node!, { asOf: node!.updated_at })).toBe(false);
});

test('a phase whose live tasks are all staged rolls up to staged', async () => {
  await stagedTask('a');
  expect(interpret(childDistribution(await setOf(), phaseId))).toBe('staged');
});

test('status precedence places staged below under_review and above queued', () => {
  expect(taskStatus({ awaiting: false, hold: 'none', lifecycle: 'staged' })).toBe('staged');
  expect(taskStatus({ awaiting: false, hold: 'blocked', lifecycle: 'staged' })).toBe('blocked');
  expect(taskStatus({ awaiting: false, hold: 'parked', lifecycle: 'staged' })).toBe('parked');
  expect(interpret({ staged: 1, under_review: 1 })).toBe('under_review');
  expect(interpret({ in_progress: 1, staged: 1 })).toBe('in_progress');
  expect(interpret({ queued: 1, staged: 1 })).toBe('staged');
  expect(interpret({ awaiting: 1, ready: 2, staged: 1 })).toBe('staged');
  expect(interpret({ done: 2, staged: 1 })).toBe('staged');
});

test('staged counts as in flight', () => {
  expect(isInFlightWord('staged')).toBe(true);
  expect(isInFlightWord('done')).toBe(false);
});
