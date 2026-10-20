import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestStore } from '@mimir/core/testing';
import type { TestStore } from '@mimir/core/testing';

import { createPairingHandler } from './pairing';

let fixture: TestStore;
beforeEach(async () => {
  fixture = await createTestStore();
});
afterEach(async () => fixture.close());

function request(body: unknown) {
  return new Request('http://host.test/auth/pairing/redeem', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

test('a device redeems its code without bearer or version headers', async () => {
  const code = await fixture.tokens.issueCode('test-device');
  const handle = createPairingHandler({ tokens: fixture.tokens });
  const response = await handle(request({ code }));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const credential: unknown = await response.json();
  expect(credential).toMatchObject({ device: 'test-device' });
  if (
    !(
      typeof credential === 'object' &&
      credential !== null &&
      'token' in credential &&
      typeof credential.token === 'string'
    )
  ) {
    throw new Error('expected a device token');
  }
  expect(await fixture.tokens.verify(credential.token)).toBe('test-device');
});

test('unknown, used, and malformed codes have the same failure and code-free log', async () => {
  const lines: string[] = [];
  const handle = createPairingHandler({ log: (line) => lines.push(line), tokens: fixture.tokens });
  const code = await fixture.tokens.issueCode('used-device');
  expect((await handle(request({ code }))).status).toBe(200);
  const attempts = [
    request({ code }),
    request({ code: 'UNKNOWN1' }),
    request({ code: 1 }),
    new Request('http://host.test/auth/pairing/redeem', { body: '{', method: 'POST' }),
  ];
  for (const attempt of attempts) {
    const response = await handle(attempt);
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'invalid pairing code' });
  }
  expect(lines).toHaveLength(4);
  for (const line of lines) {
    expect(JSON.parse(line)).toEqual({ event: 'pairing_redeem_failed', time: expect.any(String) });
    expect(line).not.toContain(code);
    expect(line).not.toContain('UNKNOWN1');
  }
});

test('five host-wide failures block even valid codes until the rolling window slides', async () => {
  let time = Date.parse('2026-10-20T12:00:00Z');
  const lines: string[] = [];
  const handle = createPairingHandler({
    clock: () => time,
    log: (line) => lines.push(line),
    tokens: fixture.tokens,
  });
  for (let i = 0; i < 5; i++) {
    const attempt = request({ code: 'UNKNOWN1' });
    attempt.headers.set('x-forwarded-for', `192.0.2.${i + 1}`);
    expect((await handle(attempt)).status).toBe(400);
    if (i === 1) {
      const code = await fixture.tokens.issueCode('success-between-failures');
      expect((await handle(request({ code }))).status).toBe(200);
    }
    time += 1000;
  }
  const code = await fixture.tokens.issueCode('limited-device');
  for (const attempt of [request({ code }), request({ code: 'UNKNOWN1' })]) {
    const response = await handle(attempt);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('595');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'too many pairing attempts' });
  }
  expect(lines).toHaveLength(5);
  expect(lines[0]).toContain('2026-10-20T12:00:00.000Z');
  time += 594_600;
  const almostReady = await handle(request({ code }));
  expect(almostReady.status).toBe(429);
  expect(almostReady.headers.get('retry-after')).toBe('1');
  time += 400;
  // Exactly the oldest failure expires; a new failure fills the rolling window again.
  expect((await handle(request({ code: 'UNKNOWN1' }))).status).toBe(400);
  const blockedAgain = await handle(request({ code }));
  expect(blockedAgain.status).toBe(429);
  expect(blockedAgain.headers.get('retry-after')).toBe('1');
  time += 1000;
  expect((await handle(request({ code }))).status).toBe(200);
});

test('concurrent redeems cannot pass the host-wide failure limit', async () => {
  const handle = createPairingHandler({ log: () => undefined, tokens: fixture.tokens });
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => handle(request({ code: 'UNKNOWN1' }))),
  );
  expect(responses.filter((response) => response.status === 400)).toHaveLength(5);
  expect(responses.filter((response) => response.status === 429)).toHaveLength(7);
  // A new host lifetime resets the in-memory counter.
  const restarted = createPairingHandler({ log: () => undefined, tokens: fixture.tokens });
  const code = await fixture.tokens.issueCode('after-restart');
  expect((await restarted(request({ code }))).status).toBe(200);
});

test('malformed requests count toward the same host-wide failure limit', async () => {
  const handle = createPairingHandler({ log: () => undefined, tokens: fixture.tokens });
  for (let i = 0; i < 5; i++) {
    expect((await handle(request({ code: 1 }))).status).toBe(400);
  }
  const code = await fixture.tokens.issueCode('blocked-by-malformed');
  const response = await handle(request({ code }));
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('600');
});
