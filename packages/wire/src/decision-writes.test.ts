import { expect, test } from 'bun:test';

import { createProject, LocalEngine } from '@mimir/core';
import { createTestStore, pairTestDevice, WINDOW_VERSION } from '@mimir/core/testing';

import { RemoteEngine } from './client';
import { createEngineHandler } from './server';

test('decision mutations cross the wire with Date instants and read back identically', async () => {
  const f = await createTestStore();
  try {
    await createProject(f.store, { key: 'DEC', name: 'Decisions' });
    const local = new LocalEngine(f.store);
    const token = await pairTestDevice(f.tokens, 'decisions');
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
    const d = await remote.decide({
      class: 'other',
      option_details: [null, 'Context'],
      options: ['Here', 'There'],
      project: 'DEC',
      question: 'Where?',
      recommended: 1,
    });
    expect(d.option_details).toEqual([null, 'Context']);
    expect(d.created_at).toBeInstanceOf(Date);
    expect(await local.getDecision({ id: d.id })).toEqual(d);
    const confirmed = await remote.confirm({ id: d.id, note: 'Accepted' });
    expect(confirmed.history[0]?.at).toBeInstanceOf(Date);
    expect(await local.getDecision({ id: d.id })).toEqual(confirmed);
    const second = await local.decide({
      class: 'other',
      options: ['Here', 'There'],
      project: 'DEC',
      question: 'Where?',
      recommended: 1,
    });
    const task = await local.create({ parent: 'DEC', title: 'Plan', type: 'initiative' });
    const child = await local.create({ parent: task.id, title: 'Build', type: 'task' });
    const updated = await remote.decisionUpdate({ id: second.id, tasks: [child.id] });
    expect(await local.getDecision({ id: second.id })).toEqual(updated);
    const overturned = await remote.overturn({ id: second.id, option: 2 });
    expect(await local.getDecision({ id: second.id })).toEqual(overturned);
    expect((await remote.getNode({ id: child.id })).decisions).toEqual([
      { id: second.id, lifecycle: 'overturned' },
    ]);
  } finally {
    await f.close();
  }
});
