import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestStore, nodeIdOf, projectIdOf, rawPatchNode } from '../../testing/store';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import {
  abandonTask,
  annotate,
  archiveProject,
  blockTask,
  completeTask,
  depend,
  groomTasks,
  parkTask,
  startTask,
  submitTask,
} from '../mutations';
import { createScratchpadService } from '../scratchpads';
import type { Store } from '../store';
import { expectMimirError } from '../testing';
import { workPageOf } from './index';

/**
 * `workPageOf` (MMR-469) — the console work page's sections for a project or a
 * container subtree. Tasks only; containers never appear as rows.
 */

let store: Store;
let closeStore: () => Promise<void>;
let initId: string;
let phaseA: string;
let phaseB: string;

beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  const projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'init' });
  initId = `MMR-${String(init.seq)}`;
  const a = await createPhase(store, { parentId: await nodeIdOf(store, initId), title: 'A' });
  phaseA = `MMR-${String(a.seq)}`;
  const b = await createPhase(store, { parentId: await nodeIdOf(store, initId), title: 'B' });
  phaseB = `MMR-${String(b.seq)}`;
});
afterEach(async () => {
  await closeStore();
});

/** Create a task under a container; returns its rendered id. */
async function task(parent: string, title: string): Promise<string> {
  const node = await createTask(store, { parentId: await nodeIdOf(store, parent), title });
  return `MMR-${String(node.seq)}`;
}

const ids = (rows: readonly { task: { id: string } }[]): string[] => rows.map((r) => r.task.id);

const viewIds = (views: readonly { id: string }[]): string[] => views.map((v) => v.id);

test('the scope names its kind, id, and title', async () => {
  expect((await workPageOf(store, 'MMR')).scope).toEqual({
    id: 'MMR',
    kind: 'project',
    title: 'Mimir',
  });
  expect((await workPageOf(store, initId)).scope).toEqual({
    id: initId,
    kind: 'initiative',
    title: 'init',
  });
  expect((await workPageOf(store, phaseA)).scope).toEqual({
    id: phaseA,
    kind: 'phase',
    title: 'A',
  });
});

test('a task id, an unknown id, and an archived project are refused', async () => {
  const t = await task(phaseA, 't');
  await expectMimirError('validation', () => workPageOf(store, t));
  await expectMimirError('not_found', () => workPageOf(store, 'MMR-999'));
  await expectMimirError('not_found', () => workPageOf(store, 'NOPE'));
  await archiveProject(store, 'MMR');
  await expectMimirError('not_found', () => workPageOf(store, 'MMR'));
});

test('now lists in_progress tasks with started time, latest note, and agent context', async () => {
  const t = await task(phaseA, 'working');
  await startTask(store, t, { branch: 'feat/x', harness: 'claude', host: 'box' });
  await annotate(store, t, 'first note');
  await annotate(store, t, 'second note');
  const idle = await task(phaseA, 'idle');
  void idle;

  const report = await workPageOf(store, 'MMR');
  expect(report.now).toHaveLength(1);
  const row = report.now[0];
  expect(row?.task.id).toBe(t);
  expect(row?.task.harness).toBe('claude');
  expect(row?.task.branch).toBe('feat/x');
  expect(row?.latestNote?.content).toBe('second note');
  expect(typeof row?.startedAt).toBe('string');
  expect(row?.scratchpads).toEqual([]);
});

test('now lists the Scratchpads anchored to the task', async () => {
  const t = await task(phaseA, 'with pad');
  const other = await task(phaseA, 'without pad');
  await startTask(store, t);
  await startTask(store, other);
  const service = createScratchpadService(store.scratchpads, store.artifacts, store);
  const pad = await service.create({ anchors: [t], project: 'MMR', title: 'working notes' });

  const rows = (await workPageOf(store, 'MMR')).now;
  expect(rows.find((r) => r.task.id === t)?.scratchpads).toEqual([
    { id: pad.id, title: 'working notes' },
  ]);
  expect(rows.find((r) => r.task.id === other)?.scratchpads).toEqual([]);
});

test('now has no note when the task has none', async () => {
  const t = await task(phaseA, 'quiet');
  await startTask(store, t);
  expect((await workPageOf(store, 'MMR')).now[0]?.latestNote).toBeNull();
});

test('needs_you orders under_review, then you-blocks, then needs-answers', async () => {
  const q = await task(phaseA, 'question');
  await groomTasks(store, [q], 'needs_answers', 'which database?');
  const blocked = await task(phaseA, 'blocked-you');
  await blockTask(store, blocked, 'need a key', 'you');
  const review = await task(phaseA, 'review');
  await startTask(store, review);
  await submitTask(store, review);

  const report = await workPageOf(store, 'MMR');
  expect(report.needsYou.map((r) => [r.task.id, r.reason])).toEqual([
    [review, 'under_review'],
    [blocked, 'blocked'],
    [q, 'needs_answers'],
  ]);
  expect(report.needsYou[2]?.question).toBe('which database?');
  expect(report.needsYou[0]?.question).toBeNull();
});

test('needs_you is most recent first within each reason', async () => {
  const older = await task(phaseA, 'older');
  const newer = await task(phaseA, 'newer');
  await blockTask(store, older, 'x', 'you');
  await blockTask(store, newer, 'y', 'you');
  await rawPatchNode(store, older, { updated_at: '2026-01-01T00:00:00.000Z' });
  expect(ids((await workPageOf(store, 'MMR')).needsYou)).toEqual([newer, older]);
});

test('a block owned by others is not in needs_you', async () => {
  const t = await task(phaseA, 'waiting on upstream');
  await blockTask(store, t, 'upstream', 'others');
  const report = await workPageOf(store, 'MMR');
  expect(report.needsYou).toEqual([]);
  expect(ids(report.frontier.runnable)).toEqual([]);
});

test('needs_answers tasks are not in the frontier', async () => {
  const q = await task(phaseA, 'q');
  await groomTasks(store, [q], 'needs_answers', 'why?');
  const report = await workPageOf(store, 'MMR');
  expect(ids(report.frontier.toGroom)).toEqual([]);
  expect(ids(report.frontier.runnable)).toEqual([]);
  expect(ids(report.needsYou)).toEqual([q]);
});

test('the frontier splits ready work into runnable and to_groom in rank order', async () => {
  const first = await task(phaseA, 'first');
  const second = await task(phaseA, 'second');
  const third = await task(phaseA, 'third');
  await groomTasks(store, [first, third], 'groomed');

  const report = await workPageOf(store, 'MMR');
  expect(ids(report.frontier.runnable)).toEqual([first, third]);
  expect(ids(report.frontier.toGroom)).toEqual([second]);
  expect(report.frontier.nextToUnlock).toEqual([]);
});

test('a task one step from ready joins the frontier; two steps away is excluded', async () => {
  const a = await task(phaseA, 'a ready');
  const b = await task(phaseA, 'b waits on a');
  const c = await task(phaseA, 'c waits on b');
  await depend(store, b, [a]);
  await depend(store, c, [b]);
  await groomTasks(store, [a, b, c], 'groomed');

  const report = await workPageOf(store, 'MMR');
  expect(ids(report.frontier.runnable)).toEqual([a]);
  expect(report.frontier.nextToUnlock.map((g) => g.prerequisite.id)).toEqual([a]);
  expect(ids(report.frontier.nextToUnlock[0]?.tasks ?? [])).toEqual([b]);
  const everywhere = [
    ...ids(report.frontier.runnable),
    ...report.frontier.nextToUnlock.flatMap((g) => ids(g.tasks)),
    ...ids(report.frontier.toGroom),
  ];
  expect(everywhere).not.toContain(c);
});

test('a task awaiting an in-flight prerequisite is one step away', async () => {
  const a = await task(phaseA, 'a');
  const b = await task(phaseA, 'b');
  await depend(store, b, [a]);
  await groomTasks(store, [b], 'groomed');
  await startTask(store, a);

  const report = await workPageOf(store, 'MMR');
  expect(report.frontier.nextToUnlock).toHaveLength(1);
  expect(report.frontier.nextToUnlock[0]?.prerequisite).toEqual({
    id: a,
    status: 'in_progress',
    title: 'a',
  });
  expect(ids(report.frontier.nextToUnlock[0]?.tasks ?? [])).toEqual([b]);
});

test('a task awaiting a blocked prerequisite is not on the frontier', async () => {
  const a = await task(phaseA, 'a');
  const b = await task(phaseA, 'b');
  await depend(store, b, [a]);
  await groomTasks(store, [b], 'groomed');
  await blockTask(store, a, 'stuck', 'others');
  const report = await workPageOf(store, 'MMR');
  expect(report.frontier.nextToUnlock).toEqual([]);
});

test('a task waiting on two frontier prerequisites appears under each, groups in prerequisite rank order', async () => {
  const a = await task(phaseA, 'a');
  const b = await task(phaseA, 'b');
  const c = await task(phaseA, 'c');
  await depend(store, c, [a, b]);
  await groomTasks(store, [c], 'groomed');

  const report = await workPageOf(store, 'MMR');
  expect(report.frontier.nextToUnlock.map((g) => g.prerequisite.id)).toEqual([a, b]);
  expect(report.frontier.nextToUnlock.map((g) => ids(g.tasks))).toEqual([[c], [c]]);
});

test('an ungroomed awaiting task is a to_groom row naming what it awaits', async () => {
  const a = await task(phaseA, 'a');
  const b = await task(phaseA, 'b');
  await depend(store, b, [a]);
  const report = await workPageOf(store, 'MMR');
  expect(report.frontier.toGroom.map((r) => [r.task.id, r.awaitingOn])).toEqual([
    [a, []],
    [b, [a]],
  ]);
});

test('an edge on a container gates its descendants and counts as one step', async () => {
  const gate = await task(phaseB, 'gate');
  const inA = await task(phaseA, 'inside A');
  await depend(store, phaseA, [gate]);
  await groomTasks(store, [gate, inA], 'groomed');

  const report = await workPageOf(store, 'MMR');
  expect(ids(report.frontier.runnable)).toEqual([gate]);
  expect(report.frontier.nextToUnlock.map((g) => [g.prerequisite.id, ids(g.tasks)])).toEqual([
    [gate, [inA]],
  ]);
});

test('a phase scope excludes tasks outside its subtree but an outside prerequisite still gates', async () => {
  const outside = await task(phaseB, 'outside');
  const outsideOther = await task(phaseB, 'outside other');
  const inA = await task(phaseA, 'inside A');
  const inA2 = await task(phaseA, 'inside A2');
  await depend(store, inA, [outside]);
  await groomTasks(store, [outside, outsideOther, inA, inA2], 'groomed');

  const report = await workPageOf(store, phaseA);
  expect(ids(report.frontier.runnable)).toEqual([inA2]);
  expect(report.frontier.nextToUnlock.map((g) => [g.prerequisite.id, ids(g.tasks)])).toEqual([
    [outside, [inA]],
  ]);
  const all = [
    ...ids(report.frontier.runnable),
    ...ids(report.frontier.toGroom),
    ...report.frontier.nextToUnlock.flatMap((g) => ids(g.tasks)),
  ];
  expect(all).not.toContain(outsideOther);
});

test('an initiative scope covers every phase beneath it', async () => {
  const inA = await task(phaseA, 'a');
  const inB = await task(phaseB, 'b');
  const report = await workPageOf(store, initId);
  expect(ids(report.frontier.toGroom)).toEqual([inA, inB]);
});

test('parked tasks are not in the frontier', async () => {
  const t = await task(phaseA, 'parked');
  await parkTask(store, t);
  const report = await workPageOf(store, 'MMR');
  expect(ids(report.frontier.toGroom)).toEqual([]);
  expect(ids(report.frontier.runnable)).toEqual([]);
});

test('shipped keeps done and abandoned tasks from the last 7 days, newest first, with abandon reason', async () => {
  const done = await task(phaseA, 'done');
  await startTask(store, done);
  await completeTask(store, done);
  const dropped = await task(phaseA, 'dropped');
  await abandonTask(store, dropped, 'no longer needed');
  const bare = await task(phaseA, 'dropped bare');
  await abandonTask(store, bare);

  const report = await workPageOf(store, 'MMR');
  expect(report.shipped.map((r) => r.task.id)).toEqual([bare, dropped, done]);
  const byId = new Map(report.shipped.map((r) => [r.task.id, r]));
  expect(byId.get(dropped)?.abandonReason).toBe('no longer needed');
  expect(byId.get(bare)?.abandonReason).toBeNull();
  expect(byId.get(done)?.abandonReason).toBeNull();
  expect(byId.get(done)?.finishedAt).toBe(byId.get(done)?.task.completedAt ?? 'unset');
});

test('shipped covers the last 7 calendar days, today included, in the caller zone', async () => {
  const edgeIn = await task(phaseA, 'edge in');
  const edgeOut = await task(phaseA, 'edge out');
  await completeTask(store, edgeIn);
  await completeTask(store, edgeOut);
  const asOf = '2026-03-16T12:00:00.000Z';

  // UTC: the window opens 2026-03-10T00:00Z (today is the 16th; 6 days back).
  await rawPatchNode(store, edgeIn, { completed_at: '2026-03-10T00:00:00.000Z' });
  await rawPatchNode(store, edgeOut, { completed_at: '2026-03-09T23:59:59.999Z' });
  expect(ids((await workPageOf(store, 'MMR', { asOf })).shipped)).toEqual([edgeIn]);

  // New York is on EDT: the 16th began at 04:00Z, so the window opens 2026-03-10T04:00Z.
  await rawPatchNode(store, edgeIn, { completed_at: '2026-03-10T04:00:00.000Z' });
  await rawPatchNode(store, edgeOut, { completed_at: '2026-03-10T03:59:59.999Z' });
  const ny = { asOf, timeZone: 'America/New_York' };
  expect(ids((await workPageOf(store, 'MMR', ny)).shipped)).toEqual([edgeIn]);
});

test('shipped excludes a completion after the end of today', async () => {
  const t = await task(phaseA, 'future');
  await completeTask(store, t);
  await rawPatchNode(store, t, { completed_at: '2026-03-17T00:00:00.000Z' });
  const report = await workPageOf(store, 'MMR', { asOf: '2026-03-16T12:00:00.000Z' });
  expect(report.shipped).toEqual([]);
});

test('shipped is scoped to the container subtree', async () => {
  const inA = await task(phaseA, 'a');
  const inB = await task(phaseB, 'b');
  await completeTask(store, inA);
  await completeTask(store, inB);
  expect(ids((await workPageOf(store, phaseA)).shipped)).toEqual([inA]);
});

test('going_stale lists stale tasks no other section shows, stalest first', async () => {
  const stale = await task(phaseA, 'stale');
  const staler = await task(phaseA, 'staler');
  const readyStale = await task(phaseA, 'ready but stale');
  const workingStale = await task(phaseA, 'working but stale');
  await blockTask(store, stale, 'x', 'others');
  await blockTask(store, staler, 'y', 'others');
  await startTask(store, workingStale);
  await rawPatchNode(store, stale, { updated_at: '2026-01-02T00:00:00.000Z' });
  await rawPatchNode(store, staler, { updated_at: '2026-01-01T00:00:00.000Z' });
  await rawPatchNode(store, readyStale, { updated_at: '2026-01-01T00:00:00.000Z' });
  await rawPatchNode(store, workingStale, { updated_at: '2026-01-01T00:00:00.000Z' });

  const report = await workPageOf(store, 'MMR', { asOf: '2026-03-01T00:00:00.000Z' });
  expect(viewIds(report.goingStale)).toEqual([staler, stale]);
  // Each of the others is shown once, in the earlier section that claims it.
  expect(ids(report.now)).toEqual([workingStale]);
  expect(ids(report.frontier.toGroom)).toContain(readyStale);
  expect(
    viewIds((await workPageOf(store, 'MMR', { asOf: '2026-01-03T00:00:00.000Z' })).goingStale),
  ).toEqual([]);
});

test('a started task blocked on you is in needs_you, not now', async () => {
  const t = await task(phaseA, 'working then blocked');
  await startTask(store, t);
  await blockTask(store, t, 'need a decision', 'you');
  const report = await workPageOf(store, 'MMR');
  expect(report.now).toEqual([]);
  expect(report.needsYou.map((r) => [r.task.id, r.reason])).toEqual([[t, 'blocked']]);
});

test('a parked or blocked needs-answers task is not a needs-answers row', async () => {
  const parked = await task(phaseA, 'parked q');
  const blocked = await task(phaseA, 'blocked q');
  await groomTasks(store, [parked, blocked], 'needs_answers', 'why?');
  await parkTask(store, parked);
  await blockTask(store, blocked, 'x', 'others');
  const report = await workPageOf(store, 'MMR');
  expect(report.needsYou).toEqual([]);
});

test('a needs-answers question is the latest note, even one added after grooming', async () => {
  const t = await task(phaseA, 'q');
  await groomTasks(store, [t], 'needs_answers', 'first question');
  await annotate(store, t, 'follow-up detail');
  expect((await workPageOf(store, 'MMR')).needsYou[0]?.question).toBe('follow-up detail');
});

test('containers never appear as rows', async () => {
  const t = await task(phaseA, 't');
  await startTask(store, t);
  const report = await workPageOf(store, 'MMR');
  const all = [
    ...ids(report.now),
    ...ids(report.needsYou),
    ...ids(report.frontier.runnable),
    ...ids(report.frontier.toGroom),
    ...ids(report.shipped),
    ...viewIds(report.goingStale),
  ];
  expect(all.every((id) => ![initId, phaseA, phaseB].includes(id))).toBe(true);
});
