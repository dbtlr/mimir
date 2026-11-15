import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { EngineInput } from '@mimir/contract';

import { createProject, createTask, createInitiative, createPhase } from './create';
import { LocalEngine } from './engine';
import { bootPglite } from './store-postgres/testing';
import { backends, errorOf } from './testing/conformance';
import type { Instance } from './testing/conformance';

beforeAll(bootPglite);
describe.each(backends)('decision reads ($name)', (backend) => {
  let f: Instance;
  let e: LocalEngine;
  beforeAll(async () => {
    f = await backend.make();
    e = new LocalEngine(f.store);
    await createProject(f.store, { key: 'DEC', name: 'Decisions' });
    await createProject(f.store, { key: 'OLD', name: 'Archived' });
    const root = await createInitiative(f.store, { projectId: 'DEC', title: 'Plan' });
    const phase = await createPhase(f.store, { parentId: root.id, title: 'Phase' });
    const done = await createTask(f.store, { parentId: phase.id, title: 'Done' });
    const abandoned = await createTask(f.store, { parentId: phase.id, title: 'Abandoned' });
    await e.start({ id: done.id });
    await e.done({ id: done.id });
    await e.abandon({ id: abandoned.id, reason: 'Stop' });
    const delivery = await e.deliveryCreate({ phase: phase.id, tasks: [], title: 'Attempt' });
    const base = { options: ['Here', 'There'], project: 'DEC', question: 'Where?', recommended: 1 };
    for (const fields of [
      { class: 'product' },
      { class: 'architecture', delivery: delivery.id, tasks: [abandoned.id] },
      { class: 'product', delivery: delivery.id, tasks: [done.id, abandoned.id] },
      { class: 'architecture', tasks: [done.id] },
      { class: 'other', tasks: [done.id] },
      { class: 'product', tasks: [done.id] },
      { class: 'architecture', tasks: [done.id] },
    ] satisfies Partial<EngineInput<'decide'>>[]) {
      await e.decide({ ...base, ...fields });
    }
    await e.confirm({ id: 'DEC-q6' });
    await e.overturn({ id: 'DEC-q7', option: 2 });
    await e.decide({ ...base, class: 'other', project: 'OLD' });
    await e.archive({ id: 'OLD' });
  });
  afterAll(async () => {
    await f.close();
  });
  const ids = async (fields: Omit<EngineInput<'listDecisions'>, 'project'> = {}) =>
    (await e.listDecisions({ project: 'DEC', ...fields })).map((d) => d.id);
  test('defaults to provisional, and names each lifecycle or all in sequence order', async () => {
    expect(await ids()).toEqual(['DEC-q1', 'DEC-q2', 'DEC-q3', 'DEC-q4', 'DEC-q5']);
    expect(await ids({ status: 'provisional' })).toEqual(await ids());
    expect(await ids({ status: 'confirmed' })).toEqual(['DEC-q6']);
    expect(await ids({ status: 'overturned' })).toEqual(['DEC-q7']);
    expect(await ids({ status: 'all' })).toEqual([
      'DEC-q1',
      'DEC-q2',
      'DEC-q3',
      'DEC-q4',
      'DEC-q5',
      'DEC-q6',
      'DEC-q7',
    ]);
  });
  test('classes are alternatives; linked includes done and excludes abandoned-only links', async () => {
    expect(await ids({ classes: ['product', 'architecture'] })).toEqual([
      'DEC-q1',
      'DEC-q2',
      'DEC-q3',
      'DEC-q4',
    ]);
    expect(await ids({ linked: true })).toEqual(['DEC-q3', 'DEC-q4', 'DEC-q5']);
  });
  test('delivery and cap filters combine with AND', async () => {
    expect(await ids({ delivery: 'DEC-d01' })).toEqual(['DEC-q2', 'DEC-q3']);
    expect(await ids({ classes: ['product', 'architecture'], linked: true })).toEqual([
      'DEC-q3',
      'DEC-q4',
    ]);
    expect(
      await ids({ classes: ['product', 'architecture'], delivery: 'DEC-d1', linked: true }),
    ).toEqual(['DEC-q3']);
    expect((await e.listDecisions({ linked: true, project: 'DEC' }))[0]?.tasks).toHaveLength(2);
  });
  test('overview counts all provisional decisions, including those outside the cap', async () => {
    expect((await e.overview({ project: 'DEC' })).provisionalDecisions).toBe(5);
    expect((await e.overview({ project: 'DEC' })).provisionalDecisions).toBe((await ids()).length);
  });
  test('archived and unknown projects are not found', async () => {
    for (const project of ['OLD', 'GONE']) {
      expect((await errorOf(e.listDecisions({ project }))).code).toBe('not_found');
    }
  });
});
