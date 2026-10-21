import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestStore, errorOf } from '@mimir/core/testing';
import type { TestStore } from '@mimir/core/testing';
import { z } from 'zod';

import { createDeviceHandlers, parseCodeInput, parseDeviceInput } from './devices';
import { createPairingHandlers } from './pairing';

let fixture: TestStore;
beforeEach(async () => {
  fixture = await createTestStore();
});
afterEach(async () => fixture.close());

const filed = z.object({ poll_secret: z.string(), user_code: z.string() });
const credential = z.object({ status: z.literal('approved'), token: z.string() });

function post(path: string, body: unknown) {
  return new Request(`http://host.test/auth/pairing/${path}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

// A client files a request over the pairing route, as `mimir pair` does.
async function clientFiles(pairing: ReturnType<typeof createPairingHandlers>, device: string) {
  return filed.parse(await (await pairing.request(post('requests', { device }))).json());
}

test('the console pairs a device a client filed, and unpairing stops its token', async () => {
  const pairing = createPairingHandlers({ log: () => undefined, tokens: fixture.tokens });
  const devices = createDeviceHandlers(fixture.tokens);
  const request = await clientFiles(pairing, 'laptop');

  expect((await devices.pendingPairings()).map((row) => row.device)).toEqual(['laptop']);
  expect(await devices.lookupPairing(request.user_code)).toMatchObject({
    device: 'laptop',
    rotates: false,
  });
  expect(await devices.approvePairing(request.user_code)).toEqual({
    device: 'laptop',
    rotates: false,
  });

  const approved = credential.parse(
    await (await pairing.poll(post('poll', { poll_secret: request.poll_secret }))).json(),
  );
  expect(await fixture.tokens.verify(approved.token)).toBe('laptop');
  expect(await devices.pairedDevices()).toEqual([
    { created_at: expect.any(String), device: 'laptop', last_used_at: expect.anything() },
  ]);

  await devices.unpairDevice('laptop');
  expect(await fixture.tokens.verify(approved.token)).toBeNull();
  expect(await devices.pairedDevices()).toEqual([]);
});

test('denying a request answers the client denied, and a spent code has no match', async () => {
  const pairing = createPairingHandlers({ log: () => undefined, tokens: fixture.tokens });
  const devices = createDeviceHandlers(fixture.tokens);
  const request = await clientFiles(pairing, 'laptop');

  expect(await devices.denyPairing(request.user_code)).toEqual({ device: 'laptop' });
  expect(
    await (await pairing.poll(post('poll', { poll_secret: request.poll_secret }))).json(),
  ).toEqual({
    status: 'denied',
  });
  expect(await devices.lookupPairing(request.user_code)).toBeNull();
});

test('approving or denying a code nothing waits on is one not-found refusal', async () => {
  const devices = createDeviceHandlers(fixture.tokens);
  for (const refused of [devices.approvePairing('ZZZZ-ZZZZ'), devices.denyPairing('nonsense')]) {
    const error = await errorOf(refused);
    expect(error).toMatchObject({
      code: 'not_found',
      message: 'No waiting request has this code.',
    });
  }
});

test('paired devices expose no token hashes', async () => {
  const pairing = createPairingHandlers({ log: () => undefined, tokens: fixture.tokens });
  const devices = createDeviceHandlers(fixture.tokens);
  const request = await clientFiles(pairing, 'laptop');
  await devices.approvePairing(request.user_code);
  await pairing.poll(post('poll', { poll_secret: request.poll_secret }));
  const [row] = await devices.pairedDevices();
  expect(Object.keys(row ?? {}).toSorted()).toEqual(['created_at', 'device', 'last_used_at']);
});

test('inputs are non-empty strings, refused as validation otherwise', () => {
  expect(parseCodeInput({ code: 'K7QM-2XRD' })).toEqual({ code: 'K7QM-2XRD' });
  expect(parseDeviceInput({ device: 'laptop' })).toEqual({ device: 'laptop' });
  for (const bad of [null, [], {}, { code: '' }, { code: 7 }, { code: 'x', extra: 1 }]) {
    expect(() => parseCodeInput(bad)).toThrow(expect.objectContaining({ code: 'validation' }));
  }
  expect(() => parseDeviceInput({ device: '' })).toThrow(
    expect.objectContaining({ code: 'validation' }),
  );
});
