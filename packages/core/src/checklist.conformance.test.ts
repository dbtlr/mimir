import { beforeAll, describe, expect, setSystemTime, test } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from './create';
import { LocalEngine } from './engine';
import { archiveProject, abandonTask, completeTask } from './mutations';
import { bootPglite } from './store-postgres/testing';
import { backends, errorOf } from './testing/conformance';

beforeAll(bootPglite);

/** One project with a phase and two tasks, over a fresh store of the backend. */
async function fixture(backend: (typeof backends)[number]) {
  const instance = await backend.make();
  const engine = new LocalEngine(instance.store);
  await createProject(instance.store, { key: 'CHK', name: 'Checklists' });
  const initiative = await createInitiative(instance.store, { projectId: 'CHK', title: 'Plan' });
  const phase = await createPhase(instance.store, { parentId: initiative.id, title: 'Phase' });
  const a = await createTask(instance.store, { parentId: phase.id, title: 'A' });
  const b = await createTask(instance.store, { parentId: phase.id, title: 'B' });
  return { a: a.id, b: b.id, engine, initiative: initiative.id, instance, phase: phase.id };
}

describe.each(backends)('checklist items ($name)', (backend) => {
  test('add numbers items from 1 per task and returns the whole checklist', async () => {
    const f = await fixture(backend);
    try {
      await f.engine.itemAdd({ content: 'first', task: f.a });
      await f.engine.itemAdd({ content: 'second', task: f.a });
      const third = await f.engine.itemAdd({ content: 'third', task: f.a });
      const other = await f.engine.itemAdd({ content: 'other task', task: f.b });
      expect(third.task).toBe(f.a);
      expect(third.items.map((item) => [item.number, item.content, item.state])).toEqual([
        [1, 'first', 'open'],
        [2, 'second', 'open'],
        [3, 'third', 'open'],
      ]);
      expect(third.items[0]).toMatchObject({
        content: 'first',
        number: 1,
        reason: null,
        settled_at: null,
        state: 'open',
      });
      expect(third.items[0]?.created_at).toBeInstanceOf(Date);
      expect(other.items.map((item) => item.number)).toEqual([1]);
    } finally {
      await f.instance.close();
    }
  });

  test('check and drop settle an open item and stamp settled_at', async () => {
    const f = await fixture(backend);
    try {
      await f.engine.itemAdd({ content: 'one', task: f.a });
      await f.engine.itemAdd({ content: 'two', task: f.a });
      setSystemTime(new Date(Date.now() + 60_000));
      const checked = await f.engine.itemCheck({ number: 1, task: f.a });
      const dropped = await f.engine.itemDrop({
        number: 2,
        reason: 'Covered by CHK-9',
        task: f.a,
      });
      expect(checked.items[0]).toMatchObject({ number: 1, reason: null, state: 'checked' });
      expect(checked.items[0]?.settled_at).toBeInstanceOf(Date);
      expect(dropped.items[1]).toMatchObject({
        number: 2,
        reason: 'Covered by CHK-9',
        state: 'dropped',
      });
      expect(dropped.items.map((item) => item.state)).toEqual(['checked', 'dropped']);
    } finally {
      setSystemTime();
      await f.instance.close();
    }
  });

  test('refuses blank content and a blank drop reason as validation', async () => {
    const f = await fixture(backend);
    try {
      await f.engine.itemAdd({ content: 'one', task: f.a });
      for (const call of [
        () => f.engine.itemAdd({ content: '  ', task: f.a }),
        () => f.engine.itemDrop({ number: 1, reason: ' ', task: f.a }),
        () => f.engine.itemDrop({ number: 1, task: f.a } as never),
      ]) {
        expect((await errorOf(call())).code).toBe('validation');
      }
      expect((await f.engine.itemCheck({ number: 1, task: f.a })).items[0]?.state).toBe('checked');
    } finally {
      await f.instance.close();
    }
  });

  test('a settled item refuses every later verb as a conflict naming state and time', async () => {
    const f = await fixture(backend);
    try {
      await f.engine.itemAdd({ content: 'one', task: f.a });
      await f.engine.itemAdd({ content: 'two', task: f.a });
      setSystemTime(new Date('2099-11-16T10:00:30.000Z'));
      await f.engine.itemCheck({ number: 1, task: f.a });
      await f.engine.itemDrop({ number: 2, reason: 'no', task: f.a });
      // One at a time: PGlite holds a single connection.
      const refusals = [
        await errorOf(f.engine.itemCheck({ number: 1, task: f.a })),
        await errorOf(f.engine.itemDrop({ number: 1, reason: 'late', task: f.a })),
        await errorOf(f.engine.itemCheck({ number: 2, task: f.a })),
        await errorOf(f.engine.itemDrop({ number: 2, reason: 'again', task: f.a })),
      ];
      expect(refusals.map((error) => error.code)).toEqual([
        'conflict',
        'conflict',
        'conflict',
        'conflict',
      ]);
      expect(refusals.map((error) => error.message)).toEqual([
        `${f.a} item 1 is already checked (2099-11-16 10:00)`,
        `${f.a} item 1 is already checked (2099-11-16 10:00)`,
        `${f.a} item 2 is already dropped (2099-11-16 10:00)`,
        `${f.a} item 2 is already dropped (2099-11-16 10:00)`,
      ]);
      const items = (await f.engine.itemAdd({ content: 'three', task: f.a })).items;
      expect(items.map((item) => item.state)).toEqual(['checked', 'dropped', 'open']);
    } finally {
      setSystemTime();
      await f.instance.close();
    }
  });

  test('an unknown number is not_found; a missing or non-Mimir task is not_found', async () => {
    const f = await fixture(backend);
    try {
      await f.engine.itemAdd({ content: 'one', task: f.a });
      const unknown = await errorOf(f.engine.itemCheck({ number: 7, task: f.a }));
      expect(unknown.code).toBe('not_found');
      expect(unknown.message).toBe(`${f.a} has no item 7`);
      expect((await errorOf(f.engine.itemDrop({ number: 7, reason: 'x', task: f.a }))).code).toBe(
        'not_found',
      );
      expect((await errorOf(f.engine.itemAdd({ content: 'x', task: 'CHK-99' }))).code).toBe(
        'not_found',
      );
      expect((await errorOf(f.engine.itemAdd({ content: 'x', task: 'nope' }))).code).toBe(
        'not_found',
      );
    } finally {
      await f.instance.close();
    }
  });

  test('the Engine schema refuses a non-positive or non-integer number as validation', async () => {
    const f = await fixture(backend);
    try {
      for (const number of [0, -1, 1.5, Number.NaN]) {
        expect((await errorOf(f.engine.itemCheck({ number, task: f.a }))).code).toBe('validation');
      }
    } finally {
      await f.instance.close();
    }
  });

  test('every id of another kind is validation, naming its kind', async () => {
    const f = await fixture(backend);
    try {
      const delivery = await f.engine.deliveryCreate({ phase: f.phase, tasks: [], title: 'Try' });
      const named: [string, string][] = [
        [f.phase, 'phase'],
        [f.initiative, 'initiative'],
        ['CHK', 'a project'],
        ['CHK-s1', 'a seed'],
        ['CHK-a1', 'an artifact'],
        [delivery.id, 'a delivery'],
        ['CHK-q1', 'a decision'],
      ];
      for (const [id, kind] of named) {
        const error = await errorOf(f.engine.itemAdd({ content: 'x', task: id }));
        expect(error.code).toBe('validation');
        expect(error.message).toContain(kind);
        expect(error.message).toContain('not a task');
      }
    } finally {
      await f.instance.close();
    }
  });

  test('a done or abandoned task still takes items', async () => {
    const f = await fixture(backend);
    try {
      await completeTask(f.instance.store, f.a);
      await abandonTask(f.instance.store, f.b, 'dropped');
      expect((await f.engine.itemAdd({ content: 'late', task: f.a })).items).toHaveLength(1);
      expect((await f.engine.itemAdd({ content: 'late', task: f.b })).items).toHaveLength(1);
    } finally {
      await f.instance.close();
    }
  });

  test('an archived project refuses every item action', async () => {
    const f = await fixture(backend);
    try {
      await f.engine.itemAdd({ content: 'one', task: f.a });
      await archiveProject(f.instance.store, 'CHK');
      const calls = [
        () => f.engine.itemAdd({ content: 'x', task: f.a }),
        () => f.engine.itemCheck({ number: 1, task: f.a }),
        () => f.engine.itemDrop({ number: 1, reason: 'x', task: f.a }),
      ];
      for (const call of calls) {
        const error = await errorOf(call());
        expect(error.code).toBe('conflict');
        expect(error.message).toContain('archived');
      }
    } finally {
      await f.instance.close();
    }
  });

  test('each subcommand moves the task updated_at, and a refusal leaves it alone', async () => {
    const f = await fixture(backend);
    try {
      const updated = async () => (await f.engine.getNode({ id: f.a })).updatedAt.toISOString();
      setSystemTime(new Date('2099-01-01T00:00:00.000Z'));
      await f.engine.itemAdd({ content: 'one', task: f.a });
      expect(await updated()).toBe('2099-01-01T00:00:00.000Z');
      setSystemTime(new Date('2099-01-02T00:00:00.000Z'));
      await f.engine.itemCheck({ number: 1, task: f.a });
      expect(await updated()).toBe('2099-01-02T00:00:00.000Z');
      setSystemTime(new Date('2099-01-03T00:00:00.000Z'));
      await f.engine.itemAdd({ content: 'two', task: f.a });
      setSystemTime(new Date('2099-01-04T00:00:00.000Z'));
      await f.engine.itemDrop({ number: 2, reason: 'no', task: f.a });
      expect(await updated()).toBe('2099-01-04T00:00:00.000Z');
      setSystemTime(new Date('2099-01-05T00:00:00.000Z'));
      await errorOf(f.engine.itemCheck({ number: 2, task: f.a }));
      expect(await updated()).toBe('2099-01-04T00:00:00.000Z');
    } finally {
      setSystemTime();
      await f.instance.close();
    }
  });

  test('settled_at clamps to created_at when the clock reads earlier', async () => {
    const f = await fixture(backend);
    try {
      setSystemTime(new Date('2099-06-01T12:00:00.000Z'));
      await f.engine.itemAdd({ content: 'one', task: f.a });
      await f.engine.itemAdd({ content: 'two', task: f.a });
      setSystemTime(new Date('2099-06-01T11:00:00.000Z'));
      const checked = await f.engine.itemCheck({ number: 1, task: f.a });
      const dropped = await f.engine.itemDrop({ number: 2, reason: 'skew', task: f.a });
      expect(checked.items[0]?.settled_at?.toISOString()).toBe('2099-06-01T12:00:00.000Z');
      expect(dropped.items[1]?.settled_at?.toISOString()).toBe('2099-06-01T12:00:00.000Z');
    } finally {
      setSystemTime();
      await f.instance.close();
    }
  });

  test('get carries the items of a task, in number order, and no other node', async () => {
    const f = await fixture(backend);
    try {
      await f.engine.itemAdd({ content: 'one', task: f.a });
      await f.engine.itemAdd({ content: 'two', task: f.a });
      await f.engine.itemCheck({ number: 1, task: f.a });
      const task = await f.engine.getNode({ id: f.a });
      expect(task.items?.map((item) => [item.number, item.state])).toEqual([
        [1, 'checked'],
        [2, 'open'],
      ]);
      expect((await f.engine.getNode({ id: f.b })).items).toEqual([]);
      expect(await f.engine.getNode({ id: f.phase })).not.toHaveProperty('items');
      for (const row of (await f.engine.list({ project: 'CHK' })).items) {
        expect(row).not.toHaveProperty('items');
      }
    } finally {
      await f.instance.close();
    }
  });
});
