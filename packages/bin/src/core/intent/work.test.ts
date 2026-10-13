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
  reopenTask,
  returnTask,
  startTask,
  submitTask,
} from '../mutations';
import { createScratchpadService } from '../scratchpads';
import type { Store } from '../store';
import { expectMimirError } from '../testing';
import { workPageOf } from './index';
import type { WorkOptions } from './work';

/**
 * `workPageOf` (MMR-469) — the console work page's sections for a project or a
 * container subtree. Rows are tasks, plus initiatives and phases with no
 * children as `breakDown` rows in `frontier.toGroom`.
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

/** The work page in UTC unless a test says otherwise (the zone is a required option). */
const page = (id: string, opts: Partial<WorkOptions> = {}) =>
  workPageOf(store, id, { timeZone: 'UTC', ...opts });

/** The task rows of a to_groom list (an empty phase also reads as a break-down row). */
const taskRows = <T extends { task: { type: string } }>(rows: readonly T[]): T[] =>
  rows.filter((r) => r.task.type === 'task');

/** The ids in the project page's to_groom list. */
const groomListed = async (): Promise<string[]> =>
  (await page('MMR')).frontier.toGroom.map((r) => r.task.id);

const ids = (rows: readonly { task: { id: string } }[]): string[] => rows.map((r) => r.task.id);

const viewIds = (views: readonly { id: string }[]): string[] => views.map((v) => v.id);

test('the scope names its kind, id, and title', async () => {
  expect((await page('MMR')).scope).toEqual({
    id: 'MMR',
    kind: 'project',
    title: 'Mimir',
  });
  expect((await page(initId)).scope).toEqual({
    id: initId,
    kind: 'initiative',
    title: 'init',
  });
  expect((await page(phaseA)).scope).toEqual({
    id: phaseA,
    kind: 'phase',
    title: 'A',
  });
});

test('a task id, an unknown id, and an archived project are refused', async () => {
  const t = await task(phaseA, 't');
  await expectMimirError('validation', () => page(t));
  await expectMimirError('not_found', () => page('MMR-999'));
  await expectMimirError('not_found', () => page('NOPE'));
  await archiveProject(store, 'MMR');
  await expectMimirError('not_found', () => page('MMR'));
});

test('now lists in_progress tasks with started time, latest note, and agent context', async () => {
  const t = await task(phaseA, 'working');
  await startTask(store, t, { branch: 'feat/x', harness: 'claude', host: 'box' });
  await annotate(store, t, 'first note');
  await annotate(store, t, 'second note');
  const idle = await task(phaseA, 'idle');
  void idle;

  const report = await page('MMR');
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

  const rows = (await page('MMR')).now;
  expect(rows.find((r) => r.task.id === t)?.scratchpads).toEqual([
    { id: pad.id, title: 'working notes' },
  ]);
  expect(rows.find((r) => r.task.id === other)?.scratchpads).toEqual([]);
});

test('now has no note when the task has none', async () => {
  const t = await task(phaseA, 'quiet');
  await startTask(store, t);
  expect((await page('MMR')).now[0]?.latestNote).toBeNull();
});

test('needs_you orders under_review, then you-blocks, then needs-answers', async () => {
  const q = await task(phaseA, 'question');
  await groomTasks(store, [q], 'needs_answers', 'which database?');
  const blocked = await task(phaseA, 'blocked-you');
  await blockTask(store, blocked, 'need a key', 'you');
  const review = await task(phaseA, 'review');
  await startTask(store, review);
  await submitTask(store, review);

  const report = await page('MMR');
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
  expect(ids((await page('MMR')).needsYou)).toEqual([newer, older]);
});

test('a block owned by others is not in needs_you', async () => {
  const t = await task(phaseA, 'waiting on upstream');
  await blockTask(store, t, 'upstream', 'others');
  const report = await page('MMR');
  expect(report.needsYou).toEqual([]);
  expect(ids(report.frontier.runnable)).toEqual([]);
});

test('needs_answers tasks are not in the frontier', async () => {
  const q = await task(phaseA, 'q');
  await groomTasks(store, [q], 'needs_answers', 'why?');
  const report = await page('MMR');
  expect(ids(taskRows(report.frontier.toGroom))).toEqual([]);
  expect(ids(report.frontier.runnable)).toEqual([]);
  expect(ids(report.needsYou)).toEqual([q]);
});

test('the frontier splits ready work into runnable and to_groom in rank order', async () => {
  const first = await task(phaseA, 'first');
  const second = await task(phaseA, 'second');
  const third = await task(phaseA, 'third');
  await groomTasks(store, [first, third], 'groomed');

  const report = await page('MMR');
  expect(ids(report.frontier.runnable)).toEqual([first, third]);
  expect(ids(taskRows(report.frontier.toGroom))).toEqual([second]);
  expect(report.frontier.nextToUnlock).toEqual([]);
});

test('a task one step from ready joins the frontier; two steps away is excluded', async () => {
  const a = await task(phaseA, 'a ready');
  const b = await task(phaseA, 'b waits on a');
  const c = await task(phaseA, 'c waits on b');
  await depend(store, b, [a]);
  await depend(store, c, [b]);
  await groomTasks(store, [a, b, c], 'groomed');

  const report = await page('MMR');
  expect(ids(report.frontier.runnable)).toEqual([a]);
  expect(report.frontier.nextToUnlock.map((g) => g.prerequisite.id)).toEqual([a]);
  expect(ids(report.frontier.nextToUnlock[0]?.tasks ?? [])).toEqual([b]);
  const everywhere = [
    ...ids(report.frontier.runnable),
    ...report.frontier.nextToUnlock.flatMap((g) => ids(g.tasks)),
    ...ids(taskRows(report.frontier.toGroom)),
  ];
  expect(everywhere).not.toContain(c);
});

test('a task awaiting an in-flight prerequisite is one step away', async () => {
  const a = await task(phaseA, 'a');
  const b = await task(phaseA, 'b');
  await depend(store, b, [a]);
  await groomTasks(store, [b], 'groomed');
  await startTask(store, a);

  const report = await page('MMR');
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
  const report = await page('MMR');
  expect(report.frontier.nextToUnlock).toEqual([]);
});

test('a task waiting on two frontier prerequisites appears under each, groups in prerequisite rank order', async () => {
  const a = await task(phaseA, 'a');
  const b = await task(phaseA, 'b');
  const c = await task(phaseA, 'c');
  await depend(store, c, [a, b]);
  await groomTasks(store, [c], 'groomed');

  const report = await page('MMR');
  expect(report.frontier.nextToUnlock.map((g) => g.prerequisite.id)).toEqual([a, b]);
  expect(report.frontier.nextToUnlock.map((g) => ids(g.tasks))).toEqual([[c], [c]]);
});

test('an ungroomed awaiting task is a to_groom row naming what it awaits', async () => {
  const a = await task(phaseA, 'a');
  const b = await task(phaseA, 'b');
  await depend(store, b, [a]);
  const report = await page('MMR');
  expect(taskRows(report.frontier.toGroom).map((r) => [r.task.id, r.awaitingOn])).toEqual([
    [a, []],
    [b, [a]],
  ]);
});

test('an edge on a container gates its descendants and counts as one step', async () => {
  const gate = await task(phaseB, 'gate');
  const inA = await task(phaseA, 'inside A');
  await depend(store, phaseA, [gate]);
  await groomTasks(store, [gate, inA], 'groomed');

  const report = await page('MMR');
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

  const report = await page(phaseA);
  expect(ids(report.frontier.runnable)).toEqual([inA2]);
  expect(report.frontier.nextToUnlock.map((g) => [g.prerequisite.id, ids(g.tasks)])).toEqual([
    [outside, [inA]],
  ]);
  const all = [
    ...ids(report.frontier.runnable),
    ...ids(taskRows(report.frontier.toGroom)),
    ...report.frontier.nextToUnlock.flatMap((g) => ids(g.tasks)),
  ];
  expect(all).not.toContain(outsideOther);
});

test('an initiative scope covers every phase beneath it', async () => {
  const inA = await task(phaseA, 'a');
  const inB = await task(phaseB, 'b');
  const report = await page(initId);
  expect(ids(taskRows(report.frontier.toGroom))).toEqual([inA, inB]);
});

test('parked tasks are not in the frontier', async () => {
  const t = await task(phaseA, 'parked');
  await parkTask(store, t);
  const report = await page('MMR');
  expect(ids(taskRows(report.frontier.toGroom))).toEqual([]);
  expect(ids(report.frontier.runnable)).toEqual([]);
});

test('shipped keeps done and abandoned tasks from today, with abandon reason', async () => {
  const done = await task(phaseA, 'done');
  await startTask(store, done);
  await completeTask(store, done);
  const dropped = await task(phaseA, 'dropped');
  await abandonTask(store, dropped, 'no longer needed');
  const bare = await task(phaseA, 'dropped bare');
  await abandonTask(store, bare);

  const report = await page('MMR');
  expect(report.shipped.map((r) => r.task.id).toSorted()).toEqual([bare, done, dropped].toSorted());
  const byId = new Map(report.shipped.map((r) => [r.task.id, r]));
  expect(byId.get(dropped)?.abandonReason).toBe('no longer needed');
  expect(byId.get(bare)?.abandonReason).toBeNull();
  expect(byId.get(done)?.abandonReason).toBeNull();
  expect(byId.get(done)?.finishedAt).toBe(byId.get(done)?.task.completedAt ?? 'unset');
});

test('shipped is ordered by finish time, newest first, whatever the seq order', async () => {
  const first = await task(phaseA, 'created first');
  const second = await task(phaseA, 'created second');
  const third = await task(phaseA, 'created third');
  for (const id of [first, second, third]) {
    await completeTask(store, id);
  }
  // Finish times that follow neither seq order nor its reverse.
  await rawPatchNode(store, first, { completed_at: '2026-03-15T10:00:00.000Z' });
  await rawPatchNode(store, second, { completed_at: '2026-03-14T09:00:00.000Z' });
  await rawPatchNode(store, third, { completed_at: '2026-03-16T01:00:00.000Z' });

  const report = await page('MMR', { asOf: '2026-03-16T12:00:00.000Z' });
  expect(ids(report.shipped)).toEqual([third, first, second]);
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
  expect(ids((await page('MMR', { asOf })).shipped)).toEqual([edgeIn]);

  // New York is on EDT: the 16th began at 04:00Z, so the window opens 2026-03-10T04:00Z.
  await rawPatchNode(store, edgeIn, { completed_at: '2026-03-10T04:00:00.000Z' });
  await rawPatchNode(store, edgeOut, { completed_at: '2026-03-10T03:59:59.999Z' });
  const ny = { asOf, timeZone: 'America/New_York' };
  expect(ids((await page('MMR', ny)).shipped)).toEqual([edgeIn]);
});

test('shipped excludes a completion after the end of today', async () => {
  const t = await task(phaseA, 'future');
  await completeTask(store, t);
  await rawPatchNode(store, t, { completed_at: '2026-03-17T00:00:00.000Z' });
  const report = await page('MMR', { asOf: '2026-03-16T12:00:00.000Z' });
  expect(report.shipped).toEqual([]);
});

test('shipped is scoped to the container subtree', async () => {
  const inA = await task(phaseA, 'a');
  const inB = await task(phaseB, 'b');
  await completeTask(store, inA);
  await completeTask(store, inB);
  expect(ids((await page(phaseA)).shipped)).toEqual([inA]);
});

test('going_cold lists every stale task, oldest first, even ones other sections show', async () => {
  const stale = await task(phaseA, 'stale');
  const staler = await task(phaseA, 'staler');
  const readyStale = await task(phaseA, 'ready but stale');
  const workingStale = await task(phaseA, 'working but stale');
  const fresh = await task(phaseA, 'fresh');
  await blockTask(store, stale, 'x', 'others');
  await blockTask(store, staler, 'y', 'others');
  await startTask(store, workingStale);
  await rawPatchNode(store, stale, { updated_at: '2026-01-02T00:00:00.000Z' });
  await rawPatchNode(store, staler, { updated_at: '2026-01-01T00:00:00.000Z' });
  await rawPatchNode(store, readyStale, { updated_at: '2026-01-01T00:00:00.000Z' });
  await rawPatchNode(store, workingStale, { updated_at: '2026-01-01T00:00:00.000Z' });
  await rawPatchNode(store, fresh, { updated_at: '2026-02-28T00:00:00.000Z' });

  const report = await page('MMR', { asOf: '2026-03-01T00:00:00.000Z' });
  // Oldest updated_at first, seq breaking the tie.
  expect(viewIds(report.goingCold)).toEqual([staler, readyStale, workingStale, stale]);
  // The earlier sections keep their rows, flagged stale.
  expect(report.now.map((r) => [r.task.id, r.stale])).toEqual([[workingStale, true]]);
  expect(taskRows(report.frontier.toGroom).find((r) => r.task.id === readyStale)?.stale).toBe(true);
  expect(report.frontier.waitingOnOthers.map((r) => [r.task.id, r.stale])).toEqual([
    [staler, true],
    [stale, true],
  ]);
  expect(viewIds((await page('MMR', { asOf: '2026-01-03T00:00:00.000Z' })).goingCold)).toEqual([]);
});

test('waiting_on_others lists tasks blocked on others, started or not, with the block reason', async () => {
  const unstarted = await task(phaseA, 'unstarted');
  const started = await task(phaseA, 'started');
  const mine = await task(phaseA, 'mine');
  const parked = await task(phaseA, 'parked');
  await blockTask(store, unstarted, 'waiting on the vendor', 'others');
  await startTask(store, started);
  await blockTask(store, started, 'needs upstream fix', 'others');
  await blockTask(store, mine, 'my call', 'you');
  await parkTask(store, parked);

  const report = await page('MMR');
  expect(report.frontier.waitingOnOthers.map((r) => [r.task.id, r.blockReason])).toEqual([
    [unstarted, 'waiting on the vendor'],
    [started, 'needs upstream fix'],
  ]);
  // Claimed by the frontier, in page order after needs_you.
  expect(ids(report.now)).toEqual([]);
  expect(ids(report.needsYou)).toEqual([mine]);
  expect(ids(report.frontier.runnable)).toEqual([]);
  expect(taskRows(report.frontier.toGroom)).toEqual([]);
});

test('a started task blocked on you is in needs_you, not now', async () => {
  const t = await task(phaseA, 'working then blocked');
  await startTask(store, t);
  await blockTask(store, t, 'need a decision', 'you');
  const report = await page('MMR');
  expect(report.now).toEqual([]);
  expect(report.needsYou.map((r) => [r.task.id, r.reason])).toEqual([[t, 'blocked']]);
});

test('a parked or blocked needs-answers task is not a needs-answers row', async () => {
  const parked = await task(phaseA, 'parked q');
  const blocked = await task(phaseA, 'blocked q');
  await groomTasks(store, [parked, blocked], 'needs_answers', 'why?');
  await parkTask(store, parked);
  await blockTask(store, blocked, 'x', 'others');
  const report = await page('MMR');
  expect(report.needsYou).toEqual([]);
});

test('a needs-answers question is the latest note, even one added after grooming', async () => {
  const t = await task(phaseA, 'q');
  await groomTasks(store, [t], 'needs_answers', 'first question');
  await annotate(store, t, 'follow-up detail');
  expect((await page('MMR')).needsYou[0]?.question).toBe('follow-up detail');
});

test('containers appear only as break-down rows in to_groom', async () => {
  const t = await task(phaseA, 't');
  await startTask(store, t);
  const report = await page('MMR');
  const everywhere = [
    ...ids(report.now),
    ...ids(report.needsYou),
    ...ids(report.frontier.runnable),
    ...ids(report.frontier.waitingOnOthers),
    ...report.frontier.nextToUnlock.flatMap((g) => ids(g.tasks)),
    ...ids(report.shipped),
    ...viewIds(report.goingCold),
  ];
  expect(everywhere.every((id) => ![initId, phaseA, phaseB].includes(id))).toBe(true);
  for (const row of report.frontier.toGroom) {
    expect(row.breakDown).toBe(row.task.type !== 'task');
  }
});

test('an empty phase is a break-down row after the to_groom tasks; a phase with children is not', async () => {
  const inA = await task(phaseA, 'a task');
  const report = await page('MMR');
  expect(report.frontier.toGroom.map((r) => [r.task.id, r.task.type, r.breakDown])).toEqual([
    [inA, 'task', false],
    [phaseB, 'phase', true],
  ]);
  expect(report.frontier.toGroom[1]?.awaitingOn).toEqual([]);
});

test('the scope itself is never a break-down row', async () => {
  const report = await page(phaseB);
  expect(report.frontier.toGroom).toEqual([]);
});

test('an initiative of empty phases lists the phases, not the initiative', async () => {
  const report = await page('MMR');
  expect(report.frontier.toGroom.map((r) => r.task.id)).toEqual([phaseA, phaseB]);
});

test('a container whose subtree is all terminal or parked is not a break-down row', async () => {
  const done = await task(phaseA, 'done');
  await completeTask(store, done);
  const parked = await task(phaseB, 'parked');
  await parkTask(store, parked);
  const report = await page('MMR');
  expect(report.frontier.toGroom).toEqual([]);
});

test('an initiative whose only child is an open-ended home is not a break-down row', async () => {
  const projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'only a home' });
  const initRef = `MMR-${String(init.seq)}`;
  const home = await createPhase(store, {
    openEnded: true,
    parentId: await nodeIdOf(store, initRef),
    title: 'Bugs',
  });
  const homeRef = `MMR-${String(home.seq)}`;

  // The standing home is empty, and the initiative still has a child.
  expect(await groomListed()).not.toContain(initRef);
  expect(await groomListed()).not.toContain(homeRef);

  // With only finished work inside, the home is transparent to rollups, but still a child.
  const finished = await task(homeRef, 'fixed');
  await completeTask(store, finished);
  expect(await groomListed()).not.toContain(initRef);
  expect(await groomListed()).not.toContain(homeRef);
});

test('waiting_on_others is ordered oldest update first, whatever the id order', async () => {
  const a = await task(phaseA, 'a');
  const b = await task(phaseA, 'b');
  const c = await task(phaseA, 'c');
  for (const id of [a, b, c]) {
    await blockTask(store, id, 'waiting', 'others');
  }
  await rawPatchNode(store, a, { updated_at: '2026-02-02T00:00:00.000Z' });
  await rawPatchNode(store, b, { updated_at: '2026-02-03T00:00:00.000Z' });
  await rawPatchNode(store, c, { updated_at: '2026-02-01T00:00:00.000Z' });
  expect(ids((await page('MMR')).frontier.waitingOnOthers)).toEqual([c, a, b]);
});

test('an empty open-ended phase (a standing home) is not a break-down row', async () => {
  const home = await createPhase(store, {
    openEnded: true,
    parentId: await nodeIdOf(store, initId),
    title: 'Bugs',
  });
  const report = await page('MMR');
  expect(report.frontier.toGroom.map((r) => r.task.id)).not.toContain(`MMR-${String(home.seq)}`);
});

test('a break-down container follows the one-step rule on its own and inherited edges', async () => {
  // phase A is empty and waits on a ready task: one step away.
  const gate = await task(phaseB, 'gate');
  await depend(store, phaseA, [gate]);
  let rows = (await page('MMR')).frontier.toGroom;
  expect(rows.find((r) => r.task.id === phaseA)?.awaitingOn).toEqual([gate]);

  // The gate itself now waits on another task: phase A is two steps away.
  const upstream = await task(phaseB, 'upstream');
  await depend(store, gate, [upstream]);
  rows = (await page('MMR')).frontier.toGroom;
  expect(rows.map((r) => r.task.id)).not.toContain(phaseA);
});

test('an edge on the parent initiative is inherited by an empty phase beneath it', async () => {
  const gate = await task(phaseB, 'gate');
  const init2 = await createInitiative(store, {
    projectId: await projectIdOf(store, 'MMR'),
    title: 'other',
  });
  const init2Id = `MMR-${String(init2.seq)}`;
  const empty = await createPhase(store, {
    parentId: await nodeIdOf(store, init2Id),
    title: 'empty',
  });
  const emptyId = `MMR-${String(empty.seq)}`;
  await depend(store, init2Id, [gate]);

  let rows = (await page('MMR')).frontier.toGroom;
  expect(rows.find((r) => r.task.id === emptyId)?.awaitingOn).toEqual([gate]);

  const upstream = await task(phaseB, 'upstream');
  await depend(store, gate, [upstream]);
  rows = (await page('MMR')).frontier.toGroom;
  expect(rows.map((r) => r.task.id)).not.toContain(emptyId);
});

test('a break-down container waiting on a blocked prerequisite is not listed', async () => {
  const gate = await task(phaseB, 'gate');
  await blockTask(store, gate, 'stuck', 'others');
  await depend(store, phaseA, [gate]);
  const rows = (await page('MMR')).frontier.toGroom;
  expect(rows.map((r) => r.task.id)).not.toContain(phaseA);
});

test('started_at is the latest start or reopen, not a return from review', async () => {
  const t = await task(phaseA, 'cycled');
  await startTask(store, t);
  await completeTask(store, t);
  await reopenTask(store, t, 'not finished');
  const history = await store.bodySections.readHistory(t);
  const reopenedAt = history.at(-1)?.at;
  expect(history.at(-1)?.to).toBe('in_progress');

  expect((await page('MMR')).now[0]?.startedAt).toBe(reopenedAt ?? 'missing');

  // A return from review keeps the earlier start.
  const r = await task(phaseA, 'returned');
  await startTask(store, r);
  const startedAt = (await store.bodySections.readHistory(r)).at(-1)?.at;
  await submitTask(store, r);
  await returnTask(store, r, 'more work');
  const row = (await page('MMR')).now.find((n) => n.task.id === r);
  expect(row?.startedAt).toBe(startedAt ?? 'missing');
});

test('runnable requires a rank, as next does', async () => {
  const ranked = await task(phaseA, 'ranked');
  const unranked = await task(phaseA, 'unranked');
  await groomTasks(store, [ranked, unranked], 'groomed');
  await rawPatchNode(store, unranked, { rank: null });
  expect(ids((await page('MMR')).frontier.runnable)).toEqual([ranked]);
});

test('every row carries a stale flag', async () => {
  const working = await task(phaseA, 'working');
  const ready = await task(phaseA, 'ready');
  const fresh = await task(phaseA, 'fresh');
  await startTask(store, working);
  await rawPatchNode(store, working, { updated_at: '2026-01-01T00:00:00.000Z' });
  await rawPatchNode(store, ready, { updated_at: '2026-01-01T00:00:00.000Z' });
  await rawPatchNode(store, fresh, { updated_at: '2026-02-28T00:00:00.000Z' });

  const report = await page('MMR', { asOf: '2026-03-01T00:00:00.000Z' });
  expect(report.now.map((r) => [r.task.id, r.stale])).toEqual([[working, true]]);
  const stale = new Map(taskRows(report.frontier.toGroom).map((r) => [r.task.id, r.stale]));
  expect(stale.get(ready)).toBe(true);
  expect(stale.get(fresh)).toBe(false);
  expect(viewIds(report.goingCold)).toEqual([working, ready]);
});

test('a missing or unknown zone is a validation error', async () => {
  await expectMimirError('validation', () => workPageOf(store, 'MMR', { timeZone: '' }));
  await expectMimirError('validation', () =>
    workPageOf(store, 'MMR', { timeZone: 'Mars/Olympus' }),
  );
});
