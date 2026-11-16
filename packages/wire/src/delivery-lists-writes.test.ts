import { expect, test } from 'bun:test';

import { createProject, LocalEngine } from '@mimir/core';
import { createTestStore, pairTestDevice, WINDOW_VERSION } from '@mimir/core/testing';

import { RemoteEngine } from './client';
import { createEngineHandler } from './server';

test('delivery list verbs cross the wire with Date instants, and refusals keep their code', async () => {
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

    const limited = await remote.deliveryLimitation({ id: delivery.id, text: 'edge case' });
    expect(limited.limitations[0]?.created_at).toBeInstanceOf(Date);
    const declined = await remote.deliveryDecline({
      finding: 'a finding',
      id: delivery.id,
      reason: 'later',
    });
    expect(declined.declined.map((entry) => entry.number)).toEqual([2]);
    expect(await remote.getDelivery({ id: delivery.id })).toEqual(
      await local.getDelivery({ id: delivery.id }),
    );
    const pad = await remote.scratchCreate({ anchors: [delivery.id], project: 'LST', title: 'J' });
    expect(pad.delivery).toBe(delivery.id);
    expect((await remote.getDelivery({ id: delivery.id })).journal.scratchpad).toBe(pad.id);

    let refusal: unknown;
    try {
      await remote.deliveryDecline({ finding: 'a', id: delivery.id, reason: ' ' });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ code: 'validation' });
  } finally {
    await f.close();
  }
});
