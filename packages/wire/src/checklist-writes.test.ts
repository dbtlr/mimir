import { expect, test } from 'bun:test';

import { createProject, LocalEngine } from '@mimir/core';
import { createTestStore, pairTestDevice, WINDOW_VERSION } from '@mimir/core/testing';

import { RemoteEngine } from './client';
import { createEngineHandler } from './server';

test('item verbs cross the wire with Date instants, refusals keep their code, and get reads them back', async () => {
  const f = await createTestStore();
  try {
    await createProject(f.store, { key: 'CHK', name: 'Checklists' });
    const local = new LocalEngine(f.store);
    const token = await pairTestDevice(f.tokens, 'checklists');
    const handle = createEngineHandler(local, {
      verifyToken: f.tokens.verify,
      version: WINDOW_VERSION,
    });
    const remote = new RemoteEngine({
      fetch: async (input, init) => {
        const response = await handle(new Request(input, init));
        return { json: () => response.json(), ok: response.ok };
      },
      headers: { authorization: `Bearer ${token}` },
      url: 'http://engine.test/trpc',
      version: WINDOW_VERSION,
    });
    const plan = await local.create({ parent: 'CHK', title: 'Plan', type: 'initiative' });
    const task = await local.create({ parent: plan.id, title: 'Build', type: 'task' });

    const added = await remote.itemAdd({ content: 'one', task: task.id });
    expect(added.items[0]?.created_at).toBeInstanceOf(Date);
    await remote.itemAdd({ content: 'two', task: task.id });
    const checked = await remote.itemCheck({ number: 1, task: task.id });
    expect(checked.items[0]?.settled_at).toBeInstanceOf(Date);
    const dropped = await remote.itemDrop({ number: 2, reason: 'no', task: task.id });
    expect(dropped.items.map((item) => item.state)).toEqual(['checked', 'dropped']);
    expect(await remote.getNode({ id: task.id })).toMatchObject({
      items: dropped.items,
    });

    let refusal: unknown;
    try {
      await remote.itemCheck({ number: 1, task: task.id });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: 'conflict' });
  } finally {
    await f.close();
  }
});
