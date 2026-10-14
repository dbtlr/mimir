import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';

import type { Instance } from '../../testing/conformance';
import { backends } from '../../testing/conformance';
import { nodeIdOf, projectIdOf, rawPatchNode } from '../../testing/store';
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
import { reviewOf, workPageOf } from './index';
import { cmpStr } from './work';

/**
 * The review page's cross-project work rows (MMR-504) on every backend: `now`,
 * `shipped`, `runnable`, and `goingCold` come from the same builders as the
 * per-project work page, so a project's rows in the review equal that project's
 * work report, and the project list carries the health counts the rail reads.
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

/** The rows as `[project, task id]` pairs in project order. */
const keyed = (rows: readonly { project: string; task: { id: string } }[]) =>
  rows.toSorted((a, b) => cmpStr(a.project, b.project)).map((r) => [r.project, r.task.id]);

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
    const bbb = await populate(store, 'BBB');
    const report = await review(store);
    expect(keyed(report.now)).toEqual([
      ['AAA', aaa.working],
      ['BBB', bbb.working],
    ]);
    expect(keyed(report.shipped)).toEqual([
      ['AAA', aaa.finished],
      ['BBB', bbb.finished],
    ]);
    expect(keyed(report.runnable)).toEqual([
      ['AAA', aaa.runnable],
      ['BBB', bbb.runnable],
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
      expect(mine(report.now)).toEqual(page.now);
      expect(mine(report.shipped)).toEqual(page.shipped);
      expect(mine(report.runnable)).toEqual(page.frontier.runnable);
      expect(mine(report.goingCold).map((r) => r.task)).toEqual(page.goingCold);
    }
    expect(report.now.some((r) => r.scratchpads.length > 0)).toBe(true);
  });

  it('shipped is newest first across projects and ends with the weekly window', async () => {
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
    // A parked task is not live work.
    const parked = await task(store, 'AAA', aaa.phase, 'parked');
    await parkTask(store, parked);
    await updateProject(store, 'CCC', { pinned: true });
    // AAA moves last, so it leads the unpinned projects.
    await Bun.sleep(5);
    await annotate(store, aaa.working, 'fresh news');
    const report = await review(store);
    expect(report.projects.map((p) => p.key)).toEqual(['CCC', 'AAA', 'BBB']);
    const byKey = new Map(report.projects.map((p) => [p.key, p]));
    // working, runnable, and cold are live; finished and the parked task are not.
    expect(byKey.get('AAA')).toMatchObject({ goingCold: 1, live: 3 });
    expect(byKey.get('BBB')).toMatchObject({ goingCold: 1, live: 3 });
  });
}
