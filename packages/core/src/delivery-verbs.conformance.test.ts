import { beforeAll, describe, expect, test } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from './create';
import { LocalEngine } from './engine';
import { bootPglite } from './store-postgres/testing';
import { backends, errorOf, refusalOf, withoutStamp } from './testing/conformance';

beforeAll(bootPglite);
describe.each(backends)('delivery verbs ($name)', (backend) => {
  async function fixture() {
    const instance = await backend.make();
    const engine = new LocalEngine(instance.store);
    await createProject(instance.store, { key: 'DEL', name: 'Delivery' });
    const initiative = await createInitiative(instance.store, { projectId: 'DEL', title: 'Plan' });
    const phase = await createPhase(instance.store, { parentId: initiative.id, title: 'Phase' });
    const tasks = [];
    for (let i = 0; i < 4; i++) {
      tasks.push(await createTask(instance.store, { parentId: phase.id, title: `Task ${i}` }));
    }
    const delivery = await engine.deliveryCreate({
      agreement: 'Ship it',
      phase: phase.id,
      title: 'Attempt',
    });
    return { ...instance, engine, id: delivery.id, tasks };
  }
  test('start, holds, submit, return and elapsed time preserve delivery handles', async () => {
    const f = await fixture();
    try {
      await f.engine.deliveryUpdate({ branch: 'integration', id: f.id });
      expect((await f.engine.deliveryStart({ id: f.id })).elapsed_minutes).not.toBeNull();
      await f.engine.deliveryBlock({ id: f.id, reason: 'decision' });
      expect(await refusalOf(f.engine.deliverySubmit({ id: f.id }))).toContain('unblock');
      await f.engine.deliveryUnblock({ id: f.id });
      await f.engine.deliveryPark({ id: f.id, reason: 'later' });
      expect(await refusalOf(f.engine.deliverySubmit({ id: f.id }))).toContain('unpark');
      await f.engine.deliveryUnpark({ id: f.id });
      await f.engine.deliverySubmit({ id: f.id });
      await f.engine.deliveryReturn({ id: f.id, reason: 'revise' });
      const d = await f.engine.getDelivery({ id: f.id });
      expect(d.lifecycle).toBe('running');
      expect(d.branch).toBe('integration');
      expect(d.history.filter((r) => r.kind === 'hold').map((r) => r.to_value)).toEqual([
        'stopped',
        'none',
        'paused',
        'none',
      ]);
    } finally {
      await f.close();
    }
  });
  test('land refuses mixed live states and holds, then completes all staged members', async () => {
    const f = await fixture();
    try {
      await f.engine.deliveryStart({ id: f.id });
      await f.engine.deliverySubmit({ id: f.id });
      expect(await refusalOf(f.engine.deliveryLand({ id: f.id }))).toContain('stage');
      for (const task of f.tasks) {
        await f.engine.start({ harness: 'codex', id: task.id, session: 'run' });
        await f.engine.submit({ id: task.id });
        await f.engine.stage({ id: task.id });
      }
      const first = f.tasks[0];
      if (!first) {
        throw new Error('fixture');
      }
      await f.engine.park({ id: first.id, reason: 'wait' });
      expect(await refusalOf(f.engine.deliveryLand({ id: f.id }))).toContain('unpark');
      await f.engine.unpark({ id: first.id });
      expect((await f.engine.deliveryLand({ id: f.id })).lifecycle).toBe('landed');
      for (const task of f.tasks) {
        const node = await f.engine.getNode({ id: task.id });
        expect(node.lifecycle).toBe('done');
        expect(node.delivery).toBe(f.id);
        expect(node.completedAt).not.toBeNull();
        expect(node.session).toBeNull();
      }
    } finally {
      await f.close();
    }
  });
  test('abandon releases mixed states, retains todo handles, clears worked handles and keeps holds', async () => {
    const f = await fixture();
    try {
      for (const [i, task] of f.tasks.entries()) {
        await f.engine.update({ harness: 'codex', id: task.id, session: 'run' });
        if (i > 0) {
          await f.engine.start({ id: task.id });
        }
        if (i > 1) {
          await f.engine.submit({ id: task.id });
        }
        if (i > 2) {
          await f.engine.stage({ id: task.id });
        }
      }
      const held = f.tasks[2];
      if (!held) {
        throw new Error('fixture');
      }
      await f.engine.block({ id: held.id, on: 'others', reason: 'upstream' });
      await f.engine.deliveryPark({ id: f.id, reason: 'wait' });
      const before = await f.store.export();
      const d = await f.engine.deliveryAbandon({ id: f.id, reason: 'reset' });
      const after = await f.store.export();
      const releases = after.transitions.filter(
        (r) => r.kind === 'lifecycle' && r.to_value === 'todo',
      );
      expect(releases).toHaveLength(3);
      expect(releases.every((r) => r.reason === 'reset')).toBe(true);
      expect(releases.some((r) => r.handles?.session === 'run')).toBe(true);
      expect(
        d.history
          .filter((r) => r.to_value === 'released')
          .every((r) => r.from_value === null && r.task !== null),
      ).toBe(true);
      const untouched = before.nodes.find((n) => n.id === f.tasks[0]?.id);
      expect(after.nodes.find((n) => n.id === untouched?.id)).toMatchObject({
        ...untouched,
        delivery: null,
        updated_at: expect.any(String),
      });
      for (const task of after.nodes.filter((n) => n.type === 'task' && n.hold === 'none')) {
        expect(task.rank).not.toBeNull();
      }
      expect(d.hold).toBe('none');
      expect(
        d.history.filter((r) => r.kind === 'member' && r.to_value === 'released'),
      ).toHaveLength(4);
      for (const [i, task] of f.tasks.entries()) {
        const node = await f.engine.getNode({ id: task.id });
        expect(node.delivery).toBeNull();
        expect(node.lifecycle).toBe('todo');
        expect(node.session).toBe(i === 0 ? 'run' : null);
        if (i === 2) {
          expect(node.hold).toBe('blocked');
          expect((await f.store.export()).nodes.find((n) => n.id === task.id)?.block_owner).toBe(
            'others',
          );
        }
      }
    } finally {
      await f.close();
    }
  });
  test('abandon release keeps hold reasons and ranks, records every handle, and logs the hold release', async () => {
    const f = await fixture();
    try {
      const [todo, ranked, held, staged] = f.tasks;
      if (!todo || !ranked || !held || !staged) {
        throw new Error('fixture');
      }
      for (const task of f.tasks) {
        await f.engine.update({ harness: 'codex', id: task.id, session: 'run' });
      }
      await f.engine.start({ id: ranked.id });
      for (const task of [held, staged]) {
        await f.engine.start({ id: task.id });
        await f.engine.submit({ id: task.id });
      }
      await f.engine.stage({ id: staged.id });
      await f.engine.block({ id: held.id, on: 'others', reason: 'upstream down' });
      // Block clears handles; restating them gives every released row a handle to record.
      await f.engine.update({ harness: 'codex', id: held.id, session: 'run' });
      await f.store.transact(async (w) => {
        await w.updateNode(todo.id, { updated_at: '2000-01-01T00:00:00.000Z' });
      });
      await f.engine.deliveryPark({ id: f.id, reason: 'wait' });
      const before = await f.store.export();
      const rankOf = (doc: typeof before, id: string) => doc.nodes.find((n) => n.id === id)?.rank;
      expect(rankOf(before, ranked.id)).not.toBeNull();
      expect(rankOf(before, held.id)).toBeNull();
      const d = await f.engine.deliveryAbandon({ id: f.id, reason: 'reset' });
      const after = await f.store.export();
      // A worked member keeps the rank it already has, a held rankless one stays rankless.
      expect(rankOf(after, ranked.id)).toBe(rankOf(before, ranked.id));
      expect(rankOf(after, held.id)).toBeNull();
      expect(rankOf(after, staged.id)).not.toBeNull();
      const heldAfter = after.nodes.find((n) => n.id === held.id);
      expect(heldAfter).toMatchObject({
        block_owner: 'others',
        hold: 'blocked',
        hold_reason: 'upstream down',
      });
      const releases = after.transitions.filter(
        (r) => r.kind === 'lifecycle' && r.to_value === 'todo',
      );
      expect(releases).toHaveLength(3);
      expect(new Set(releases.map((r) => r.node_id))).toEqual(
        new Set([ranked.id, held.id, staged.id]),
      );
      for (const row of releases) {
        expect(row.handles).toEqual({ harness: 'codex', session: 'run' });
        expect(row.reason).toBe('reset');
      }
      expect(after.nodes.find((n) => n.id === todo.id)?.updated_at).not.toBe(
        '2000-01-01T00:00:00.000Z',
      );
      const tail = d.history.slice(-2);
      expect(tail.map((r) => [r.kind, r.from_value, r.to_value])).toEqual([
        ['hold', 'paused', 'none'],
        ['lifecycle', 'agreed', 'abandoned'],
      ]);
      expect(d.hold_reason).toBeNull();
    } finally {
      await f.close();
    }
  });
  test('a blank optional reason stores as none, and a blank required reason still refuses', async () => {
    const f = await fixture();
    try {
      await f.engine.deliveryStart({ id: f.id });
      for (const reason of ['', '  ']) {
        await f.engine.deliverySubmit({ id: f.id });
        const d = await f.engine.deliveryReturn({ id: f.id, reason });
        expect(d.history.at(-1)).toMatchObject({ kind: 'lifecycle', reason: null });
      }
      expect(await refusalOf(f.engine.deliveryBlock({ id: f.id, reason: '\n' }))).toContain(
        'reason',
      );
    } finally {
      await f.close();
    }
  });
  test('every delivery verb refuses an archived project as a conflict and writes nothing', async () => {
    const f = await fixture();
    try {
      const id = f.id;
      const refusesArchived = async (actions: (() => Promise<unknown>)[]) => {
        await f.engine.archive({ id: 'DEL' });
        const before = await f.store.export();
        for (const action of actions) {
          expect((await errorOf(action())).code).toBe('conflict');
        }
        expect(withoutStamp(await f.store.export())).toEqual(withoutStamp(before));
        await f.engine.unarchive({ id: 'DEL' });
      };
      await refusesArchived([
        () => f.engine.deliveryStart({ id }),
        () => f.engine.deliveryBlock({ id, reason: 'wait' }),
        () => f.engine.deliveryPark({ id, reason: 'wait' }),
        () => f.engine.deliveryAbandon({ id, reason: 'stop' }),
      ]);
      await f.engine.deliveryBlock({ id, reason: 'wait' });
      await refusesArchived([() => f.engine.deliveryUnblock({ id })]);
      await f.engine.deliveryUnblock({ id });
      await f.engine.deliveryPark({ id, reason: 'wait' });
      await refusesArchived([() => f.engine.deliveryUnpark({ id })]);
      await f.engine.deliveryUnpark({ id });
      await f.engine.deliveryStart({ id });
      await refusesArchived([() => f.engine.deliverySubmit({ id })]);
      await f.engine.deliverySubmit({ id });
      for (const task of f.tasks) {
        await f.engine.start({ id: task.id });
        await f.engine.submit({ id: task.id });
        await f.engine.stage({ id: task.id });
      }
      await refusesArchived([
        () => f.engine.deliveryReturn({ id, reason: 'again' }),
        () => f.engine.deliveryLand({ id }),
      ]);
    } finally {
      await f.close();
    }
  });
  test('a lifecycle refusal names the fix the lifecycle allows', async () => {
    const f = await fixture();
    try {
      const id = f.id;
      await f.engine.deliveryStart({ id });
      const running = await refusalOf(f.engine.deliveryStart({ id }));
      expect(running).toContain('start requires an agreed delivery (is running)');
      expect(running).toContain(`submit ${id}`);
      expect(running).not.toContain('create delivery');
      await f.engine.deliverySubmit({ id });
      const milestone = await refusalOf(f.engine.deliveryStart({ id }));
      expect(milestone).toContain(`land ${id}`);
      expect(milestone).toContain(`return ${id}`);
      const [todo, working, review] = f.tasks;
      if (!todo || !working || !review) {
        throw new Error('fixture');
      }
      await f.engine.start({ id: working.id });
      await f.engine.start({ id: review.id });
      await f.engine.submit({ id: review.id });
      const hints = async () => refusalOf(f.engine.deliveryLand({ id }));
      expect(await hints()).toContain(
        `${todo.id} is not staged — start ${todo.id}, submit it, then stage it`,
      );
      await f.engine.update({ delivery: null, id: todo.id });
      expect(await hints()).toContain(
        `${working.id} is not staged — submit ${working.id}, then stage it`,
      );
      await f.engine.update({ delivery: null, id: working.id });
      expect(await hints()).toContain(`${review.id} is not staged — stage ${review.id}`);
    } finally {
      await f.close();
    }
  });
  test('start requires an agreement and a live member; no refusal writes history', async () => {
    const f = await fixture();
    try {
      await f.engine.deliveryUpdate({ agreement: null, id: f.id });
      expect(await refusalOf(f.engine.deliveryStart({ id: f.id }))).toContain('--agreement');
      for (const task of f.tasks) {
        await f.engine.update({ delivery: null, id: task.id });
      }
      expect(await refusalOf(f.engine.deliveryStart({ id: f.id }))).toContain('--delivery');
      expect(
        (await f.engine.getDelivery({ id: f.id })).history.every((r) => r.kind === 'member'),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
  test('every lifecycle and hold verb refuses incorrect sources, holds and terminal writes atomically', async () => {
    const f = await fixture();
    try {
      const id = f.id;
      expect(await refusalOf(f.engine.deliverySubmit({ id }))).toContain('start');
      expect(await refusalOf(f.engine.deliveryReturn({ id }))).toContain('submit');
      expect(await refusalOf(f.engine.deliveryLand({ id }))).toContain('submit');
      expect(await refusalOf(f.engine.deliveryUnblock({ id }))).toContain('block');
      expect(await refusalOf(f.engine.deliveryUnpark({ id }))).toContain('park');
      for (const hold of ['stopped', 'paused'] as const) {
        if (hold === 'stopped') {
          await f.engine.deliveryBlock({ id, reason: 'wait' });
        } else {
          await f.engine.deliveryPark({ id, reason: 'wait' });
        }
        const fix = hold === 'stopped' ? 'unblock' : 'unpark';
        const before = await f.store.export();
        for (const action of [
          () => f.engine.deliveryStart({ id }),
          () => f.engine.deliverySubmit({ id }),
          () => f.engine.deliveryReturn({ id }),
          () => f.engine.deliveryLand({ id }),
          () => f.engine.deliveryBlock({ id, reason: 'again' }),
          () => f.engine.deliveryPark({ id, reason: 'again' }),
        ]) {
          expect(await refusalOf(action())).toContain(fix);
        }
        expect(withoutStamp(await f.store.export())).toEqual(withoutStamp(before));
        if (hold === 'stopped') {
          await f.engine.deliveryUnblock({ id });
        } else {
          await f.engine.deliveryUnpark({ id });
        }
      }
      await f.engine.deliveryStart({ id });
      expect(await refusalOf(f.engine.deliveryStart({ id }))).toContain('agreed');
      expect(await refusalOf(f.engine.deliveryReturn({ id }))).toContain('submit');
      await f.engine.deliverySubmit({ id });
      expect(await refusalOf(f.engine.deliverySubmit({ id }))).toContain('return');
      await f.engine.deliveryAbandon({ id, reason: 'cancel' });
      const before = await f.store.export();
      for (const action of [
        () => f.engine.deliveryStart({ id }),
        () => f.engine.deliverySubmit({ id }),
        () => f.engine.deliveryReturn({ id }),
        () => f.engine.deliveryLand({ id }),
        () => f.engine.deliveryBlock({ id, reason: 'wait' }),
        () => f.engine.deliveryPark({ id, reason: 'wait' }),
        () => f.engine.deliveryUnblock({ id }),
        () => f.engine.deliveryUnpark({ id }),
        () => f.engine.deliveryAbandon({ id, reason: 'again' }),
      ]) {
        expect(await refusalOf(action())).toContain('terminal');
      }
      expect(withoutStamp(await f.store.export())).toEqual(withoutStamp(before));
    } finally {
      await f.close();
    }
  });
  test('required reasons refuse blank input and land requires at least one staged member', async () => {
    const f = await fixture();
    try {
      for (const action of [
        () => f.engine.deliveryBlock({ id: f.id, reason: ' ' }),
        () => f.engine.deliveryPark({ id: f.id, reason: '' }),
        () => f.engine.deliveryAbandon({ id: f.id, reason: '' }),
      ]) {
        expect(await refusalOf(action())).toContain('reason');
      }
      await f.engine.deliveryStart({ id: f.id });
      await f.engine.deliverySubmit({ id: f.id });
      for (const task of f.tasks) {
        await f.engine.update({ delivery: null, id: task.id });
      }
      expect(await refusalOf(f.engine.deliveryLand({ id: f.id }))).toContain('no staged member');
    } finally {
      await f.close();
    }
  });
  test.each(['todo', 'in_progress', 'under_review', 'blocked', 'parked'] as const)(
    'land refuses a %s member without partially completing staged siblings',
    async (state) => {
      const f = await fixture();
      try {
        await f.engine.deliveryStart({ id: f.id });
        await f.engine.deliverySubmit({ id: f.id });
        for (const task of f.tasks) {
          await f.engine.start({ id: task.id });
          await f.engine.submit({ id: task.id });
          await f.engine.stage({ id: task.id });
        }
        const task = f.tasks[3];
        if (!task) {
          throw new Error('fixture');
        }
        if (state === 'blocked') {
          await f.engine.block({ id: task.id, reason: 'wait' });
        } else if (state === 'parked') {
          await f.engine.park({ id: task.id, reason: 'wait' });
        } else {
          await f.engine.return({ id: task.id });
          if (state === 'under_review') {
            await f.engine.submit({ id: task.id });
          }
          if (state === 'todo') {
            await f.store.transact(async (w) => {
              await w.updateNode(task.id, { lifecycle: 'todo' });
            });
          }
        }
        const before = await f.store.export();
        expect(await refusalOf(f.engine.deliveryLand({ id: f.id }))).toContain(
          {
            blocked: 'unblock',
            in_progress: 'stage',
            parked: 'unpark',
            todo: 'stage',
            under_review: 'stage',
          }[state],
        );
        expect(withoutStamp(await f.store.export())).toEqual(withoutStamp(before));
      } finally {
        await f.close();
      }
    },
  );
});
