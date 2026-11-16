import { expect, test } from 'bun:test';

import { createProject, LocalEngine } from '@mimir/core';
import { createTestStore, pairTestDevice, WINDOW_VERSION } from '@mimir/core/testing';

import { RemoteEngine } from './client';
import { createEngineHandler } from './server';

test('follow-up updates cross the wire with detail echoes and Date instants', async () => {
  const f = await createTestStore();
  try {
    await createProject(f.store, { key: 'LST', name: 'Lists' });
    const local = new LocalEngine(f.store);
    const token = await pairTestDevice(f.tokens, 'lists');
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
    const plan = await local.create({ parent: 'LST', title: 'Plan', type: 'initiative' });
    const phase = await local.create({ parent: plan.id, title: 'Phase', type: 'phase' });
    const delivery = await remote.deliveryCreate({ phase: phase.id, tasks: [], title: 'Attempt' });

    const task = await local.create({ parent: phase.id, title: 'Cleanup', type: 'task' });
    const linked = await remote.deliveryUpdate({ follow_ups: [task.id], id: delivery.id });
    expect(linked.follow_ups[0]?.linked_at).toBeInstanceOf(Date);
    expect(linked).toEqual(await local.getDelivery({ id: delivery.id }));
    const feed = await remote.deliverySince({
      id: delivery.id,
      since: new Date('2020-01-01T00:00:00.000Z'),
    });
    expect(feed.events.find((event) => event.kind === 'follow_up')?.text).toBe(task.id);
    expect(
      (await remote.deliveryUpdate({ id: delivery.id, unfollow_ups: [task.id] })).follow_ups,
    ).toEqual([]);
    let refusal: unknown;
    try {
      await remote.deliveryUpdate({ id: delivery.id, unfollow_ups: [task.id] });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: 'validation' });
  } finally {
    await f.close();
  }
});
