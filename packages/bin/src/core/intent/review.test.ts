import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestStore, nodeIdOf, projectIdOf, rawPatchNode } from '../../testing/store';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import {
  archiveProject,
  blockTask,
  groomTasks,
  parkTask,
  startTask,
  submitTask,
} from '../mutations';
import { fileSeed, parkSeed } from '../seeds';
import type { Store } from '../store';
import { reviewOf, workPageOf } from './index';
import type { ReviewOptions } from './review';

/**
 * `reviewOf` (MMR-477) — the console's cross-project review page: decisions
 * grouped by project, the focus-queue order, per-project triage, and the
 * project list. Ordering rules are ADR 0019's MMR-476 refinement.
 */

let store: Store;
let closeStore: () => Promise<void>;
/** Per project key: the phase new tasks are created under. */
const phases = new Map<string, string>();

beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  phases.clear();
});
afterEach(async () => {
  await closeStore();
});

/** Create a project with one phase for its tasks. */
async function project(key: string, name = key): Promise<void> {
  await createProject(store, { key, name });
  const init = await createInitiative(store, {
    projectId: await projectIdOf(store, key),
    title: 'init',
  });
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, `${key}-${String(init.seq)}`),
    title: 'phase',
  });
  phases.set(key, `${key}-${String(phase.seq)}`);
}

/** Create a task in the project's phase; returns its rendered id. */
async function task(key: string, title: string): Promise<string> {
  const parent = phases.get(key);
  if (parent === undefined) {
    throw new Error(`no project ${key}`);
  }
  const node = await createTask(store, { parentId: await nodeIdOf(store, parent), title });
  return `${key}-${String(node.seq)}`;
}

/** A task awaiting the operator's verdict. */
async function underReview(key: string, title = 'review'): Promise<string> {
  const id = await task(key, title);
  await startTask(store, id);
  await submitTask(store, id);
  return id;
}

/** A task blocked on the operator. */
async function blockedOnYou(key: string, title = 'blocked'): Promise<string> {
  const id = await task(key, title);
  await blockTask(store, id, 'need a key', 'you');
  return id;
}

/** A task with an open question. */
async function question(key: string, title = 'question'): Promise<string> {
  const id = await task(key, title);
  await groomTasks(store, [id], 'needs_answers', 'which database?');
  return id;
}

const at = (id: string, updated_at: string) => rawPatchNode(store, id, { updated_at });

const review = (opts: ReviewOptions = {}, findings: ReadonlyMap<string, number> = new Map()) =>
  reviewOf(store, findings, opts);

const rowIds = (group: { rows: readonly { task: { id: string } }[] }): string[] =>
  group.rows.map((r) => r.task.id);

test('decisions are under-review, you-blocked, and needs-answers tasks, each with its reason', async () => {
  await project('MMR');
  const verdict = await underReview('MMR');
  const block = await blockedOnYou('MMR');
  const ask = await question('MMR');
  const [group] = (await review()).decisions;
  expect(group?.project).toEqual({ key: 'MMR', name: 'MMR' });
  expect(group?.rows.map((r) => [r.task.id, r.reason])).toEqual([
    [verdict, 'under_review'],
    [block, 'blocked'],
    [ask, 'needs_answers'],
  ]);
  expect(group?.rows[2]?.question).toBe('which database?');
  expect(group?.rows[0]?.question).toBeNull();
});

test('work nobody is waiting on the operator for is not a decision', async () => {
  await project('MMR');
  const others = await task('MMR', 'upstream');
  await blockTask(store, others, 'upstream', 'others');
  const parkedQuestion = await question('MMR', 'parked question');
  await parkTask(store, parkedQuestion);
  await task('MMR', 'plain');
  const working = await task('MMR', 'working');
  await startTask(store, working);
  const report = await review();
  expect(report.decisions).toEqual([]);
  expect(report.queue).toEqual([]);
});

test('an archived project contributes nothing and is not listed', async () => {
  await project('MMR');
  await project('OLD');
  await underReview('OLD');
  await fileSeed(store, { kind: 'idea', project: 'OLD', title: 'old seed' });
  await archiveProject(store, 'OLD');
  const report = await review({}, new Map([['OLD', 4]]));
  expect(report.decisions).toEqual([]);
  expect(report.triage).toEqual([]);
  expect(report.projects.map((p) => p.key)).toEqual(['MMR']);
});

test('rows within a project follow the work page', async () => {
  await project('MMR');
  const olderReview = await underReview('MMR', 'older');
  const newerReview = await underReview('MMR', 'newer');
  await blockedOnYou('MMR');
  await question('MMR');
  await at(olderReview, '2026-01-01T00:00:00.000Z');
  const [group] = (await review()).decisions;
  const page = await workPageOf(store, 'MMR', { timeZone: 'UTC' });
  expect(rowIds(group ?? { rows: [] })).toEqual(page.needsYou.map((r) => r.task.id));
  expect(rowIds(group ?? { rows: [] }).slice(0, 2)).toEqual([newerReview, olderReview]);
  expect(group?.rows.map((r) => r.stale)).toEqual(page.needsYou.map((r) => r.stale));
});

test('projects with decisions order by their leading reason, then recency, then key', async () => {
  for (const key of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']) {
    await project(key);
  }
  // DDD leads with a verdict; BBB and CCC tie on a block (CCC newer); EEE has only a question.
  const ddd = await underReview('DDD');
  const bbb = await blockedOnYou('BBB');
  const ccc = await blockedOnYou('CCC');
  await question('EEE');
  await at(bbb, '2026-01-01T00:00:00.000Z');
  await at(ccc, '2026-02-01T00:00:00.000Z');
  // AAA has no decisions.
  const report = await review();
  expect(report.decisions.map((g) => g.project.key)).toEqual(['DDD', 'CCC', 'BBB', 'EEE']);
  expect(report.projects.map((p) => p.key)).toEqual(['DDD', 'CCC', 'BBB', 'EEE', 'AAA']);
  expect(report.decisions[0]?.rows[0]?.task.id).toBe(ddd);
});

test('a tie on leading reason and recency falls to the key', async () => {
  await project('BBB');
  await project('AAA');
  const b = await blockedOnYou('BBB');
  const a = await blockedOnYou('AAA');
  await at(b, '2026-01-01T00:00:00.000Z');
  await at(a, '2026-01-01T00:00:00.000Z');
  expect((await review()).decisions.map((g) => g.project.key)).toEqual(['AAA', 'BBB']);
});

test('projects without decisions follow, by triage count then key', async () => {
  for (const key of ['AAA', 'BBB', 'CCC', 'DDD']) {
    await project(key);
  }
  await underReview('DDD');
  await fileSeed(store, { kind: 'bug', project: 'BBB', title: 'one' });
  await fileSeed(store, { kind: 'bug', project: 'CCC', title: 'one' });
  await fileSeed(store, { kind: 'bug', project: 'CCC', title: 'two' });
  const report = await review();
  expect(report.projects.map((p) => [p.key, p.decisions, p.triage])).toEqual([
    ['DDD', 1, 0],
    ['CCC', 0, 2],
    ['BBB', 0, 1],
    ['AAA', 0, 0],
  ]);
});

test('the queue walks every verdict, then every block, then every question, newest first', async () => {
  await project('AAA');
  await project('BBB');
  const aReview = await underReview('AAA');
  const bReview = await underReview('BBB');
  const aBlock = await blockedOnYou('AAA');
  const bBlock = await blockedOnYou('BBB');
  const aAsk = await question('AAA');
  const bAsk = await question('BBB');
  await at(aReview, '2026-01-01T00:00:00.000Z');
  await at(bBlock, '2026-01-02T00:00:00.000Z');
  await at(aBlock, '2026-01-03T00:00:00.000Z');
  await at(aAsk, '2026-01-04T00:00:00.000Z');
  await at(bAsk, '2026-01-05T00:00:00.000Z');
  expect((await review()).queue).toEqual([bReview, aReview, aBlock, bBlock, bAsk, aAsk]);
});

test('triage lists untriaged seeds oldest first, never a parked seed', async () => {
  await project('MMR');
  const first = await fileSeed(store, { kind: 'idea', project: 'MMR', title: 'first' });
  const second = await fileSeed(store, { kind: 'bug', project: 'MMR', title: 'second' });
  const parked = await fileSeed(store, { kind: 'idea', project: 'MMR', title: 'parked' });
  await parkSeed(store, parked.id);
  const report = await review();
  expect(report.triage).toHaveLength(1);
  expect(report.triage[0]?.seeds.map((s) => s.id)).toEqual([first.id, second.id]);
  expect(report.projects[0]?.triage).toBe(2);
});

test('triage counts tasks going cold as of the reference time', async () => {
  await project('MMR');
  const cold = await task('MMR', 'cold');
  const fresh = await task('MMR', 'fresh');
  await at(cold, '2026-01-01T00:00:00.000Z');
  await at(fresh, '2026-02-28T00:00:00.000Z');
  const report = await review({ asOf: '2026-03-01T00:00:00.000Z' });
  expect(report.triage[0]?.goingCold).toBe(1);
  expect(report.triage[0]?.seeds).toEqual([]);
  expect(report.projects[0]?.triage).toBe(1);
});

test('triage counts the findings handed in and ignores keys that are not active projects', async () => {
  await project('MMR');
  await project('OLD');
  await archiveProject(store, 'OLD');
  const report = await review(
    {},
    new Map([
      ['MMR', 3],
      ['store', 7],
      ['OLD', 2],
    ]),
  );
  expect(report.triage.map((t) => [t.project.key, t.findings])).toEqual([['MMR', 3]]);
  expect(report.projects.map((p) => [p.key, p.triage])).toEqual([['MMR', 3]]);
});

test('triage orders by count descending, then key, and omits projects with nothing', async () => {
  for (const key of ['AAA', 'BBB', 'CCC', 'DDD']) {
    await project(key);
  }
  await fileSeed(store, { kind: 'idea', project: 'AAA', title: 'a' });
  const report = await review(
    {},
    new Map([
      ['BBB', 1],
      ['CCC', 5],
    ]),
  );
  expect(report.triage.map((t) => [t.project.key, t.findings])).toEqual([
    ['CCC', 5],
    ['AAA', 0],
    ['BBB', 1],
  ]);
});

test('inFlight counts the in-progress tasks of each project', async () => {
  await project('AAA');
  await project('BBB');
  const a = await task('AAA', 'one');
  const b = await task('AAA', 'two');
  await startTask(store, a);
  await startTask(store, b);
  await underReview('BBB');
  const report = await review();
  expect(report.projects.map((p) => [p.key, p.inFlight])).toEqual([
    ['BBB', 0],
    ['AAA', 2],
  ]);
});

test('an all-clear store has no decisions, queue, or triage but still lists its projects', async () => {
  await project('BBB', 'Bravo');
  await project('AAA', 'Alpha');
  await task('AAA', 'plain');
  expect(await review()).toEqual({
    decisions: [],
    projects: [
      { decisions: 0, inFlight: 0, key: 'AAA', name: 'Alpha', triage: 0 },
      { decisions: 0, inFlight: 0, key: 'BBB', name: 'Bravo', triage: 0 },
    ],
    queue: [],
    triage: [],
  });
});

test('review and the work page agree on who needs the operator', async () => {
  await project('MMR');
  await underReview('MMR');
  await blockedOnYou('MMR');
  await question('MMR');
  const other = await task('MMR', 'waiting');
  await blockTask(store, other, 'upstream', 'others');
  const parkedQuestion = await question('MMR', 'parked');
  await parkTask(store, parkedQuestion);
  const page = await workPageOf(store, 'MMR', { timeZone: 'UTC' });
  const report = await review();
  expect(report.queue.toSorted()).toEqual(page.needsYou.map((r) => r.task.id).toSorted());
  expect(report.projects[0]?.decisions).toBe(page.needsYou.length);
});
