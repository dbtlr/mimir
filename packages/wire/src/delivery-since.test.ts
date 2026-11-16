import { expect, test } from 'bun:test';

import { createProject, LocalEngine } from '@mimir/core';
import { createTestStore, pairTestDevice, WINDOW_VERSION } from '@mimir/core/testing';

import { RemoteEngine } from './client';
import { createEngineHandler } from './server';

test('the since read crosses the wire with Date instants, equal to the local read, and refusals keep their code', async () => {
  const f = await createTestStore();
  try {
    await createProject(f.store, { key: 'SNC', name: 'Since' });
    const local = new LocalEngine(f.store);
    const token = await pairTestDevice(f.tokens, 'since');
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
    const plan = await local.create({ parent: 'SNC', title: 'Plan', type: 'initiative' });
    const phase = await local.create({ parent: plan.id, title: 'Phase', type: 'phase' });
    const delivery = await remote.deliveryCreate({ phase: phase.id, tasks: [], title: 'Attempt' });
    await remote.deliveryLimitation({ id: delivery.id, text: 'edge case' });

    const since = new Date('2000-01-01T00:00:00.000Z');
    const read = await remote.deliverySince({ id: delivery.id, since });
    expect(read.since).toEqual(since);
    expect(read.as_of).toBeInstanceOf(Date);
    expect(read.events[0]?.at).toBeInstanceOf(Date);
    expect(read.events.map((event) => event.kind)).toEqual(['limitation']);
    expect(read.delivery).toEqual(await remote.getDelivery({ id: delivery.id }));

    let refusal: unknown;
    try {
      await remote.deliverySince({ id: 'SNC-d99', since });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: 'not_found' });
  } finally {
    await f.close();
  }
});
