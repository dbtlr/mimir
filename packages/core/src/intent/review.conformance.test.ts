import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from '../create';
import {
  abandonTask,
  annotate,
  archiveProject,
  completeTask,
  groomTasks,
  parkTask,
  startTask,
  updateProject,
} from '../mutations';
import { createScratchpadService } from '../scratchpads';
import type { Store } from '../store';
import type { Instance } from '../testing/conformance';
import { backends } from '../testing/conformance';
import { nodeIdOf, projectIdOf, rawPatchNode } from '../testing/store';
import { reviewOf, workPageOf } from './index';
import { cmpStr } from './work';

/**
 * The review page's cross-project work rows (MMR-504) on every backend: `now`,
 * `shipped`, `runnable`, and `goingCold` come from the same builders as the
 * per-project work page, so a project's rows in the review equal that project's
 * work report, and the project list carries the health counts the rail reads.
 * Across projects the lists have their own order: `now` most recently started
 * first, `runnable` in project (rail) order then rank, `goingCold` longest quiet
 * first, `shipped` newest first.
 */

setDefaultTimeout(60_000);

const TZ = 'UTC';
const LONG_AGO = '2020-01-01T00:00:00.000Z';

/** One of each kind of row the review's work lists carry, for one project. */
type Fixture = {
  key: string;
  phase: string;
  working: string;
  finished: string;
  runnable: string;
  cold: string;
};

async function task(store: Store, key: string, phase: string, title: string): Promise<string> {
  const node = await createTask(store, { parentId: await nodeIdOf(store, phase), title });
  return `${key}-${String(node.seq)}`;
}

/** Step past the current millisecond so the next stamp is observably later. */
const tick = (): Promise<void> => Bun.sleep(5);

async function populate(store: Store, key: string): Promise<Fixture> {
  await createProject(store, { key, name: key });
  const init = await createInitiative(store, {
    projectId: await projectIdOf(store, key),
    title: 'init',
  });
  const phaseNode = await createPhase(store, {
    parentId: await nodeIdOf(store, `${key}-${String(init.seq)}`),
    title: 'phase',
  });
  const phase = `${key}-${String(phaseNode.seq)}`;
  const working = await task(store, key, phase, `${key} working`);
  await startTask(store, working);
  await annotate(store, working, `${key} note`);
  const finished = await task(store, key, phase, `${key} finished`);
  await completeTask(store, finished);
  const runnable = await task(store, key, phase, `${key} runnable`);
  await groomTasks(store, [runnable], 'groomed');
  const cold = await task(store, key, phase, `${key} cold`);
  await rawPatchNode(store, cold, { updated_at: LONG_AGO });
  return { cold, finished, key, phase, runnable, working };
}

/** The rows as `[project, task id]` pairs, in the order given. */
const keyed = (rows: readonly { project: string; task: { id: string } }[]) =>
  rows.map((r) => [r.project, r.task.id]);

/** Drop the `project` field a review row adds, leaving the work page's row shape. */
const withoutProject = <T extends { project: string }>(row: T): Omit<T, 'project'> => {
  const { project: _project, ...rest } = row;
  return rest;
};

// oxlint-disable-next-line vitest/prefer-each
for (const backend of backends) {
  const instances: Instance[] = [];
  const fresh = async (): Promise<Store> => {
    const instance = await backend.make();
    instances.push(instance);
    return instance.store;
  };
  afterEach(async () => {
    while (instances.length > 0) {
      await instances.pop()?.close();
    }
  });
  const it = (name: string, body: () => Promise<void>): void => {
    test(`${backend.name}: ${name}`, body);
  };
  const review = (store: Store) => reviewOf(store, new Map(), { timeZone: TZ });

  it('each work list spans the active projects, with the project key on every row', async () => {
    const store = await fresh();
    const aaa = await populate(store, 'AAA');
    await tick();
    const bbb = await populate(store, 'BBB');
    await rawPatchNode(store, aaa.cold, { updated_at: '2019-01-01T00:00:00.000Z' });
    const report = await review(store);
    // BBB is newer on every axis but going cold, where AAA has been quiet longer.
    expect(keyed(report.now)).toEqual([
      ['BBB', bbb.working],
      ['AAA', aaa.working],
    ]);
    expect(keyed(report.shipped)).toEqual([
      ['BBB', bbb.finished],
      ['AAA', aaa.finished],
    ]);
    expect(keyed(report.runnable)).toEqual([
      ['BBB', bbb.runnable],
      ['AAA', aaa.runnable],
    ]);
    expect(keyed(report.goingCold)).toEqual([
      ['AAA', aaa.cold],
      ['BBB', bbb.cold],
    ]);
  });

  it('an archived project contributes no work rows', async () => {
    const store = await fresh();
    await populate(store, 'AAA');
    await populate(store, 'OLD');
    await archiveProject(store, 'OLD');
    const report = await review(store);
    for (const list of [report.now, report.shipped, report.runnable, report.goingCold]) {
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((r) => r.project === 'AAA')).toBe(true);
    }
    expect(report.projects.map((p) => p.key)).toEqual(['AAA']);
  });

  it("a project's rows in the review equal that project's work report", async () => {
    const store = await fresh();
    const keys = ['AAA', 'BBB', 'CCC'];
    for (const key of keys) {
      const fx = await populate(store, key);
      // A second row per list, so order within a project is observable.
      const second = await task(store, key, fx.phase, `${key} second working`);
      await startTask(store, second);
      const dropped = await task(store, key, fx.phase, `${key} dropped`);
      await abandonTask(store, dropped, 'scope cut');
      const secondRunnable = await task(store, key, fx.phase, `${key} second runnable`);
      await groomTasks(store, [secondRunnable], 'groomed');
      const secondCold = await task(store, key, fx.phase, `${key} second cold`);
      await rawPatchNode(store, secondCold, { updated_at: '2020-02-01T00:00:00.000Z' });
      // Stale tasks that also sit in another section: going cold repeats them.
      await rawPatchNode(store, fx.working, { updated_at: LONG_AGO });
      await rawPatchNode(store, secondRunnable, { updated_at: '2020-03-01T00:00:00.000Z' });
      await tick();
    }
    const pads = createScratchpadService(store.scratchpads, store.artifacts, store);
    const [anchor] = (await workPageOf(store, 'AAA', { timeZone: TZ })).now;
    await pads.create({ anchors: [anchor?.task.id ?? ''], project: 'AAA', title: 'pad' });
    const report = await review(store);
    for (const key of keys) {
      const page = await workPageOf(store, key, { timeZone: TZ });
      const mine = <T extends { project: string }>(rows: readonly T[]) =>
        rows.filter((r) => r.project === key).map(withoutProject);
      expect(page.now.length).toBeGreaterThan(1);
      expect(page.shipped.length).toBeGreaterThan(1);
      expect(page.frontier.runnable.length).toBeGreaterThan(1);
      expect(page.goingCold.length).toBeGreaterThan(1);
      // The staleness of a task in another section is carried on its row.
      expect(page.now.some((r) => r.stale)).toBe(true);
      expect(page.frontier.runnable.some((r) => r.stale)).toBe(true);
      // The review lists `now` most recently started first; the page lists it in rank order.
      expect(mine(report.now)).toEqual(
        page.now.toSorted((a, b) => cmpStr(b.startedAt, a.startedAt)),
      );
      expect(mine(report.shipped)).toEqual(page.shipped);
      expect(mine(report.runnable)).toEqual(page.frontier.runnable);
      expect(mine(report.goingCold).map((r) => r.task)).toEqual(page.goingCold);
    }
    expect(report.now.some((r) => r.scratchpads.length > 0)).toBe(true);
  });

  it('orders the lists across projects: started, project then rank, quiet, newest finish', async () => {
    const store = await fresh();
    const fixtures = new Map<string, Fixture>();
    // AAA, BBB, CCC are created and started in that order.
    for (const key of ['AAA', 'BBB', 'CCC']) {
      const fx = await populate(store, key);
      fixtures.set(key, fx);
      await groomTasks(
        store,
        [await task(store, key, fx.phase, `${key} second runnable`)],
        'groomed',
      );
      await tick();
    }
    const at = (key: string): Fixture => {
      const fx = fixtures.get(key);
      if (fx === undefined) {
        throw new Error(`no fixture ${key}`);
      }
      return fx;
    };
    // Rail order: CCC pinned, then AAA (newest activity), then BBB.
    await updateProject(store, 'CCC', { pinned: true });
    await tick();
    await rawPatchNode(store, at('AAA').cold, { updated_at: '2020-03-01T00:00:00.000Z' });
    await rawPatchNode(store, at('BBB').cold, { updated_at: '2020-01-01T00:00:00.000Z' });
    await rawPatchNode(store, at('CCC').cold, { updated_at: '2020-02-01T00:00:00.000Z' });
    await rawPatchNode(store, at('AAA').finished, { completed_at: '2026-03-02T00:00:00.000Z' });
    await rawPatchNode(store, at('BBB').finished, { completed_at: '2026-03-03T00:00:00.000Z' });
    await rawPatchNode(store, at('CCC').finished, { completed_at: '2026-03-01T00:00:00.000Z' });
    await tick();
    await annotate(store, at('AAA').working, 'fresh news');
    const report = await reviewOf(store, new Map(), {
      asOf: '2026-03-04T00:00:00.000Z',
      timeZone: TZ,
    });
    expect(report.projects.map((p) => p.key)).toEqual(['CCC', 'AAA', 'BBB']);
    // Most recently started first.
    expect(report.now.map((r) => r.project)).toEqual(['CCC', 'BBB', 'AAA']);
    // Project order, then the project's own rank.
    const runnable = report.runnable.map((r) => r.task.id);
    const rankOf = async (key: string): Promise<string[]> =>
      (await workPageOf(store, key, { timeZone: TZ })).frontier.runnable.map((r) => r.task.id);
    expect(runnable).toEqual([
      ...(await rankOf('CCC')),
      ...(await rankOf('AAA')),
      ...(await rankOf('BBB')),
    ]);
    expect(runnable).toHaveLength(6);
    // Longest quiet first.
    expect(report.goingCold.map((r) => r.project)).toEqual(['BBB', 'CCC', 'AAA']);
    // Newest finish first.
    expect(report.shipped.map((r) => r.project)).toEqual(['BBB', 'AAA', 'CCC']);
  });

  it('shipped ends with the weekly window', async () => {
    const store = await fresh();
    const aaa = await populate(store, 'AAA');
    const bbb = await populate(store, 'BBB');
    await rawPatchNode(store, aaa.finished, { completed_at: '2026-03-01T00:00:00.000Z' });
    await rawPatchNode(store, bbb.finished, { completed_at: '2026-03-02T00:00:00.000Z' });
    const inside = await reviewOf(store, new Map(), {
      asOf: '2026-03-03T12:00:00.000Z',
      timeZone: TZ,
    });
    expect(inside.shipped.map((r) => r.task.id)).toEqual([bbb.finished, aaa.finished]);
    const outside = await reviewOf(store, new Map(), {
      asOf: '2026-03-20T00:00:00.000Z',
      timeZone: TZ,
    });
    expect(outside.shipped).toEqual([]);
  });

  it('without a zone the shipped list is empty and the rest is unchanged', async () => {
    const store = await fresh();
    const aaa = await populate(store, 'AAA');
    const report = await reviewOf(store, new Map());
    expect(report.shipped).toEqual([]);
    expect(report.lastFinished?.task.id).toBe(aaa.finished);
    expect(report.now.map((r) => r.task.id)).toEqual([aaa.working]);
  });

  it('projects carry live and going-cold counts, pinned first then newest activity', async () => {
    const store = await fresh();
    const aaa = await populate(store, 'AAA');
    await populate(store, 'BBB');
    await populate(store, 'CCC');
    // `live` is the `--status live` group: parked work counts, finished work does not.
    const parked = await task(store, 'AAA', aaa.phase, 'parked');
    await parkTask(store, parked);
    const dropped = await task(store, 'AAA', aaa.phase, 'dropped');
    await abandonTask(store, dropped, 'scope cut');
    await updateProject(store, 'CCC', { pinned: true });
    // AAA moves last, so it leads the unpinned projects.
    await tick();
    await annotate(store, aaa.working, 'fresh news');
    const report = await review(store);
    expect(report.projects.map((p) => p.key)).toEqual(['CCC', 'AAA', 'BBB']);
    const byKey = new Map(report.projects.map((p) => [p.key, p]));
    // AAA: working, runnable, cold, parked. The finished and abandoned tasks are not live.
    expect(byKey.get('AAA')).toMatchObject({ goingCold: 1, live: 4 });
    expect(byKey.get('BBB')).toMatchObject({ goingCold: 1, live: 3 });
  });
}
