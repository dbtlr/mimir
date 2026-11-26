import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from '../create';
import { LocalEngine } from '../engine';
import {
  abandonTask,
  archiveProject,
  blockTask,
  completeTask,
  depend,
  groomTasks,
  parkTask,
  startTask,
  submitTask,
} from '../mutations';
import { fileSeed, parkSeed } from '../seeds';
import type { Store } from '../store';
import { createTestStore, nodeIdOf, projectIdOf, rawPatchNode } from '../testing/store';
import { reviewOf, workPageOf } from './index';
import type { ReviewOptions } from './review';
import { cmpStr } from './work';

/**
 * `reviewOf` (MMR-477) — the console's cross-project review page: needsYou
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
async function project(key: string, name = key): Promise<string> {
  await createProject(store, { key, name });
  const init = await createInitiative(store, {
    projectId: await projectIdOf(store, key),
    title: 'init',
  });
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, `${key}-${String(init.seq)}`),
    title: 'phase',
  });
  phases.set(key, phase.id);
  return phase.id;
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

/** A task under review: submitted to its review gate. */
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

const review = async (
  opts: ReviewOptions = {},
  findings: ReadonlyMap<string, number> | Promise<ReadonlyMap<string, number>> = new Map(),
) => {
  const report = await reviewOf(store, findings, opts);
  return {
    ...report,
    needsYou: report.needsYou.map((g) => ({
      project: g.project,
      rows: g.rows.filter((r) => r.kind === 'task'),
    })),
  };
};

const rowIds = (group: { rows: readonly { task: { id: string } }[] }): string[] =>
  group.rows.map((r) => r.task.id);

test('needsYou are you-blocked and needs-answers tasks, each with its reason', async () => {
  await project('MMR');
  const block = await blockedOnYou('MMR');
  const ask = await question('MMR');
  const [group] = (await review()).needsYou;
  expect(group?.project).toEqual({ key: 'MMR', name: 'MMR' });
  expect(group?.rows.map((r) => [r.task.id, r.reason])).toEqual([
    [block, 'blocked'],
    [ask, 'needs_answers'],
  ]);
  expect(group?.rows[1]?.question).toBe('which database?');
  expect(group?.rows[0]?.question).toBeNull();
});

test('a delivery bundle carries the delivery and phase titles', async () => {
  const phase = await project('MMR');
  const engine = new LocalEngine(store);
  const delivery = await engine.deliveryCreate({ phase, tasks: [], title: 'Ship the report' });
  await engine.decide({
    class: 'other',
    delivery: delivery.id,
    options: ['A', 'B'],
    question: 'Which option?',
    recommended: 1,
  });

  const { needsYouFacts } = await engine.console.review({ timeZone: 'UTC' });
  expect(needsYouFacts).toEqual({
    bundles: [{ set: { id: delivery.id, kind: 'delivery' }, tasks: [] }],
    deliveries: [
      { id: delivery.id, phase: { id: phase, title: 'phase' }, title: 'Ship the report' },
    ],
  });
});

test('stopped deliveries carry phase titles and retain the ID when a phase is missing', async () => {
  const phase = await project('MMR');
  const missingPhase = await project('OLD');
  const engine = new LocalEngine(store);
  const stopped = await engine.deliveryCreate({ phase, tasks: [], title: 'Needs a key' });
  const missing = await engine.deliveryCreate({
    phase: missingPhase,
    tasks: [],
    title: 'Needs a plan',
  });
  await engine.deliveryBlock({ id: stopped.id, reason: 'Key' });
  await engine.deliveryBlock({ id: missing.id, reason: 'Plan' });

  // The database enforces the phase reference. Omit its node from the read snapshot.
  const loadWorkingSet = store.loadWorkingSet;
  store.loadWorkingSet = async () => {
    const set = await loadWorkingSet();
    return { ...set, nodes: set.nodes.filter((node) => node.id !== missingPhase) };
  };
  const { needsYouFacts } = await engine.console.review({ timeZone: 'UTC' });
  expect(needsYouFacts.bundles).toEqual([]);
  expect(needsYouFacts.deliveries.toSorted((a, b) => cmpStr(a.id, b.id))).toEqual([
    { id: stopped.id, phase: { id: phase, title: 'phase' }, title: 'Needs a key' },
    { id: missing.id, phase: { id: missingPhase, title: null }, title: 'Needs a plan' },
  ]);
});

test('a stopped delivery and its bundle share facts with distinct non-abandoned tasks in queue order', async () => {
  const phase = await project('MMR');
  const engine = new LocalEngine(store);
  const first = await task('MMR', 'First by task ID');
  const abandoned = await task('MMR', 'Dropped');
  const last = await task('MMR', 'Last by task ID');
  const delivery = await engine.deliveryCreate({ phase, tasks: [], title: 'Ship' });
  const decide = (prompt: string, tasks: string[]) =>
    engine.decide({
      class: 'other',
      delivery: delivery.id,
      options: ['A', 'B'],
      question: prompt,
      recommended: 1,
      tasks,
    });
  try {
    setSystemTime(new Date('2026-11-20T12:00:00Z'));
    await decide('Older', [first, abandoned, last]);
    setSystemTime(new Date('2026-11-21T12:00:00Z'));
    await decide('Newer', [last]);
  } finally {
    setSystemTime();
  }
  await abandonTask(store, abandoned, 'Scope cut');
  await completeTask(store, last);
  await engine.deliveryBlock({ id: delivery.id, reason: 'Waiting for a key' });

  const { needsYouFacts } = await engine.console.review({ timeZone: 'UTC' });
  expect(needsYouFacts).toEqual({
    bundles: [{ set: { id: delivery.id, kind: 'delivery' }, tasks: [last, first] }],
    deliveries: [{ id: delivery.id, phase: { id: phase, title: 'phase' }, title: 'Ship' }],
  });
});

test('a project bundle carries the tasks linked by its decisions without a delivery', async () => {
  await project('MMR');
  const engine = new LocalEngine(store);
  const linked = await task('MMR', 'Use the chosen option');
  await engine.decide({
    class: 'other',
    options: ['A', 'B'],
    project: 'MMR',
    question: 'Which option?',
    recommended: 1,
    tasks: [linked],
  });

  const { needsYouFacts } = await engine.console.review({ timeZone: 'UTC' });
  expect(needsYouFacts).toEqual({
    bundles: [{ set: { key: 'MMR', kind: 'project' }, tasks: [linked] }],
    deliveries: [],
  });
});

test('now lists a review by when it was submitted, other rows by when they started', async () => {
  await project('MMR');
  const reviewed = await task('MMR', 'started first, submitted last');
  const working = await task('MMR', 'started second');
  try {
    setSystemTime(new Date('2026-10-01T09:00:00Z'));
    await startTask(store, reviewed);
    setSystemTime(new Date('2026-10-02T09:00:00Z'));
    await startTask(store, working);
    setSystemTime(new Date('2026-10-03T09:00:00Z'));
    await submitTask(store, reviewed);
  } finally {
    setSystemTime();
  }
  expect((await review()).now.map((r) => r.task.id)).toEqual([reviewed, working]);
});

test('an archived project contributes nothing and is not listed', async () => {
  await project('MMR');
  await project('OLD');
  await underReview('OLD');
  await fileSeed(store, { kind: 'idea', project: 'OLD', title: 'old seed' });
  await archiveProject(store, 'OLD');
  const report = await review({}, new Map([['OLD', 4]]));
  expect(report.needsYou).toEqual([]);
  expect(report.projects.map((p) => p.key)).toEqual(['MMR']);
});

test('rows within a project follow the work page', async () => {
  await project('MMR');
  const olderBlock = await blockedOnYou('MMR', 'older');
  const newerBlock = await blockedOnYou('MMR', 'newer');
  await question('MMR');
  await at(olderBlock, '2026-01-01T00:00:00.000Z');
  const [group] = (await review()).needsYou;
  const page = await workPageOf(store, 'MMR', { timeZone: 'UTC' });
  expect(rowIds(group ?? { rows: [] })).toEqual(
    page.needsYou.filter((r) => r.kind === 'task').map((r) => r.task.id),
  );
  expect(rowIds(group ?? { rows: [] }).slice(0, 2)).toEqual([newerBlock, olderBlock]);
  expect(group?.rows.map((r) => r.stale)).toEqual(
    page.needsYou.filter((r) => r.kind === 'task').map((r) => r.stale),
  );
});

test('projects with needsYou order by their leading reason, then recency, then key', async () => {
  for (const key of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']) {
    await project(key);
  }
  // BBB and CCC tie on a block (CCC newer); EEE has only a question, newer than both blocks.
  const bbb = await blockedOnYou('BBB');
  const ccc = await blockedOnYou('CCC');
  const eee = await question('EEE');
  await at(bbb, '2026-01-01T00:00:00.000Z');
  await at(ccc, '2026-02-01T00:00:00.000Z');
  await at(eee, '2026-03-01T00:00:00.000Z');
  // AAA has no needsYou, and DDD only a review, which is work in flight.
  await underReview('DDD');
  const report = await review();
  expect(report.needsYou.map((g) => g.project.key)).toEqual(['CCC', 'BBB', 'EEE']);
  expect(report.needsYou[0]?.rows[0]?.task.id).toBe(ccc);
});

test('a tie on leading reason and recency falls to the key', async () => {
  await project('BBB');
  await project('AAA');
  const b = await blockedOnYou('BBB');
  const a = await blockedOnYou('AAA');
  await at(b, '2026-01-01T00:00:00.000Z');
  await at(a, '2026-01-01T00:00:00.000Z');
  expect((await review()).needsYou.map((g) => g.project.key)).toEqual(['AAA', 'BBB']);
});

test("a project's recency is its newest decision of its leading reason, not its newest decision", async () => {
  await project('AAA');
  await project('BBB');
  // AAA's block is older than BBB's, though AAA's question is the newest decision of all.
  const aBlock = await blockedOnYou('AAA');
  const aAsk = await question('AAA');
  const bBlock = await blockedOnYou('BBB');
  await at(aBlock, '2026-01-01T00:00:00.000Z');
  await at(bBlock, '2026-02-01T00:00:00.000Z');
  await at(aAsk, '2026-03-01T00:00:00.000Z');
  expect((await review()).needsYou.map((g) => g.project.key)).toEqual(['BBB', 'AAA']);
});

test('the queue walks every block, then every question, newest first, and skips reviews', async () => {
  await project('AAA');
  await project('BBB');
  const aReview = await underReview('AAA');
  await underReview('BBB');
  const aBlock = await blockedOnYou('AAA');
  const bBlock = await blockedOnYou('BBB');
  const aAsk = await question('AAA');
  const bAsk = await question('BBB');
  await at(aReview, '2026-01-01T00:00:00.000Z');
  await at(bBlock, '2026-01-02T00:00:00.000Z');
  await at(aBlock, '2026-01-03T00:00:00.000Z');
  await at(aAsk, '2026-01-04T00:00:00.000Z');
  await at(bAsk, '2026-01-05T00:00:00.000Z');
  expect((await review()).queue.map((r) => r.id)).toEqual([aBlock, bBlock, bAsk, aAsk]);
});

test('untriaged counts the seeds still to triage, never a parked seed', async () => {
  await project('MMR');
  await fileSeed(store, { kind: 'idea', project: 'MMR', title: 'first' });
  await fileSeed(store, { kind: 'bug', project: 'MMR', title: 'second' });
  const parked = await fileSeed(store, { kind: 'idea', project: 'MMR', title: 'parked' });
  await parkSeed(store, parked.id);
  const [mmr] = (await review()).projects;
  expect(mmr).toMatchObject({ triage: 2, untriaged: 2 });
});

test("the runnable count is the work page's frontier.runnable rows: groomed, ready, and ranked", async () => {
  await project('MMR');
  const prerequisite = await task('MMR', 'one');
  await groomTasks(store, [prerequisite, await task('MMR', 'two')], 'groomed');
  // Not runnable: an ungroomed task, a groomed one with no rank, and a groomed,
  // ranked one awaiting an open prerequisite.
  await task('MMR', 'ungroomed');
  const unranked = await task('MMR', 'unranked');
  await groomTasks(store, [unranked], 'groomed');
  await rawPatchNode(store, unranked, { rank: null });
  const awaiting = await task('MMR', 'awaiting');
  await groomTasks(store, [awaiting], 'groomed');
  await depend(store, awaiting, [prerequisite]);
  const page = await workPageOf(store, 'MMR', { timeZone: 'UTC' });
  expect(page.frontier.runnable).toHaveLength(2);
  expect((await review()).projects[0]?.runnable).toBe(page.frontier.runnable.length);
});

test("the going-cold count matches the work page's Going cold section it links to", async () => {
  await project('MMR');
  const asOf = '2026-03-01T00:00:00.000Z';
  const ids = [
    await task('MMR', 'ready'),
    await underReview('MMR'),
    await blockedOnYou('MMR'),
    await task('MMR', 'parked'),
    await task('MMR', 'running'),
  ];
  await parkTask(store, ids[3] ?? '');
  await startTask(store, ids[4] ?? '');
  for (const id of ids) {
    await at(id, '2026-01-01T00:00:00.000Z');
  }
  // Fresh as of asOf but cold by the wall clock, so both sides must classify at asOf.
  await at(await task('MMR', 'fresh'), '2026-02-28T00:00:00.000Z');
  const page = await workPageOf(store, 'MMR', { asOf, timeZone: 'UTC' });
  const report = await review({ asOf });
  expect(page.goingCold.length).toBeGreaterThan(0);
  expect(report.projects[0]?.goingCold).toBe(page.goingCold.length);
});

test('findings can arrive as a promise, so the doctor scan overlaps the store load', async () => {
  await project('MMR');
  const report = await review({}, Promise.resolve(new Map([['MMR', 2]])));
  expect(report.projects[0]?.findings).toBe(2);
});

test('findings count what is handed in and ignore keys that are not active projects', async () => {
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
  expect(report.projects.map((p) => [p.key, p.findings, p.triage])).toEqual([['MMR', 3, 3]]);
});

test('triage sums untriaged seeds, going cold, and findings per project', async () => {
  const asOf = '2026-03-01T00:00:00.000Z';
  for (const key of ['AAA', 'BBB', 'CCC', 'DDD']) {
    await project(key);
  }
  await underReview('DDD');
  await fileSeed(store, { kind: 'idea', project: 'AAA', title: 'a' });
  await at(await task('AAA', 'quiet'), '2026-01-01T00:00:00.000Z');
  await at(await task('BBB', 'quiet'), '2026-01-01T00:00:00.000Z');
  const report = await review(
    { asOf },
    new Map([
      ['BBB', 1],
      ['CCC', 5],
    ]),
  );
  expect(
    report.projects
      .toSorted((a, b) => cmpStr(a.key, b.key))
      .map((p) => [p.key, p.untriaged, p.goingCold, p.findings, p.triage]),
  ).toEqual([
    ['AAA', 1, 1, 0, 2],
    ['BBB', 0, 1, 1, 2],
    ['CCC', 0, 0, 5, 5],
    ['DDD', 0, 0, 0, 0],
  ]);
});
test('inFlight counts the in-progress and under-review tasks of each project', async () => {
  await project('AAA');
  await project('BBB');
  const a = await task('AAA', 'one');
  const b = await task('AAA', 'two');
  await startTask(store, a);
  await startTask(store, b);
  await underReview('BBB');
  const report = await review();
  expect(
    report.projects.toSorted((x, y) => cmpStr(x.key, y.key)).map((p) => [p.key, p.inFlight]),
  ).toEqual([
    ['AAA', 2],
    ['BBB', 1],
  ]);
});

test('an all-clear store has no needsYou, queue, or work rows but still lists its projects', async () => {
  await project('BBB', 'Bravo');
  await project('AAA', 'Alpha');
  await task('AAA', 'plain');
  const report = await review();
  expect(report.needsYouFacts).toEqual({ bundles: [], deliveries: [] });
  const { needsYou, now, queue, shipped } = report;
  expect({ needsYou, now, queue, shipped }).toEqual({
    needsYou: [],
    now: [],
    queue: [],
    shipped: [],
  });
  const zero = {
    findings: 0,
    goingCold: 0,
    inFlight: 0,
    needsYou: 0,
    runnable: 0,
    triage: 0,
    untriaged: 0,
  };
  // AAA's task is the newest activity, so it leads the rail.
  expect(report.projects).toEqual([
    { ...zero, key: 'AAA', live: 1, name: 'Alpha' },
    { ...zero, key: 'BBB', live: 0, name: 'Bravo' },
  ]);
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
  expect(report.queue.map((r) => r.id).toSorted()).toEqual(
    page.needsYou
      .filter((r) => r.kind === 'task')
      .map((r) => r.task.id)
      .toSorted(),
  );
  expect(report.projects[0]?.needsYou).toBe(page.needsYou.length);
});
