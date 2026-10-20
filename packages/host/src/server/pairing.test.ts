import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestStore } from '@mimir/core/testing';
import type { TestStore } from '@mimir/core/testing';
import { z } from 'zod';

import { createPairingHandlers } from './pairing';

let fixture: TestStore;
beforeEach(async () => {
  fixture = await createTestStore();
});
afterEach(async () => fixture.close());

const filed = z.object({
  expires_at: z.string(),
  interval: z.literal(2),
  poll_secret: z.string(),
  user_code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
});

function post(path: string, body: unknown) {
  return new Request(`http://host.test/auth/pairing/${path}`, {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

async function file(handlers: ReturnType<typeof createPairingHandlers>, device: string) {
  const response = await handlers.request(post('requests', { device }));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return filed.parse(await response.json());
}

async function poll(handlers: ReturnType<typeof createPairingHandlers>, secret: unknown) {
  const response = await handlers.poll(post('poll', { poll_secret: secret }));
  expect(response.headers.get('cache-control')).toBe('no-store');
  return { body: await response.json(), status: response.status };
}

test('a client files a request without bearer or version headers and polls it to a token', async () => {
  const lines: string[] = [];
  const handlers = createPairingHandlers({
    log: (line) => lines.push(line),
    tokens: fixture.tokens,
  });
  const request = await file(handlers, 'test-device');
  expect(await poll(handlers, request.poll_secret)).toEqual({
    body: { status: 'pending' },
    status: 200,
  });
  expect(await fixture.tokens.approve(request.user_code)).toEqual({
    device: 'test-device',
    rotates: false,
  });
  const approved = await poll(handlers, request.poll_secret);
  const credential = z
    .object({ device: z.literal('test-device'), status: z.literal('approved'), token: z.string() })
    .parse(approved.body);
  expect(approved.status).toBe(200);
  expect(await fixture.tokens.verify(credential.token)).toBe('test-device');
  expect(await poll(handlers, request.poll_secret)).toEqual({
    body: { status: 'expired' },
    status: 200,
  });
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    { device: 'test-device', event: 'pairing_requested', time: expect.any(String) },
    { device: 'test-device', event: 'pairing_completed', time: expect.any(String) },
  ]);
  for (const line of lines) {
    expect(line).not.toContain(request.poll_secret);
    expect(line).not.toContain(request.user_code);
    expect(line).not.toContain(credential.token);
  }
});

test('a denied request answers denied once, and unknown secrets answer expired', async () => {
  const handlers = createPairingHandlers({ log: () => undefined, tokens: fixture.tokens });
  const request = await file(handlers, 'denied-device');
  await fixture.tokens.deny(request.user_code);
  expect((await poll(handlers, request.poll_secret)).body).toEqual({ status: 'denied' });
  expect((await poll(handlers, request.poll_secret)).body).toEqual({ status: 'expired' });
  expect((await poll(handlers, 'unknown')).body).toEqual({ status: 'expired' });
  expect(await fixture.tokens.list({ all: true })).toEqual([]);
});

test('malformed request and poll bodies receive uniform 400s', async () => {
  const lines: string[] = [];
  const handlers = createPairingHandlers({
    log: (line) => lines.push(line),
    tokens: fixture.tokens,
  });
  for (const body of [{}, { device: 1 }, { device: '' }, { device: 'line\nbreak' }, '{', 'null']) {
    const response = await handlers.request(post('requests', body));
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'invalid pairing request' });
  }
  for (const body of [{}, { poll_secret: 1 }, '{', 'null']) {
    const response = await handlers.poll(post('poll', body));
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'invalid pairing poll' });
  }
  expect(lines).toEqual([]);
  expect(await fixture.tokens.listPending()).toEqual([]);
});

test('ten host-wide request creations per rolling ten minutes, then 429 with Retry-After', async () => {
  let time = Date.parse('2026-10-20T12:00:00Z');
  const handlers = createPairingHandlers({
    clock: () => time,
    log: () => undefined,
    tokens: fixture.tokens,
  });
  const first = await file(handlers, 'device-0');
  time += 1000;
  for (let i = 1; i < 10; i++) {
    // Malformed bodies create nothing and do not spend the limit.
    expect((await handlers.request(post('requests', { device: '' }))).status).toBe(400);
    const attempt = post('requests', { device: `device-${String(i)}` });
    attempt.headers.set('x-forwarded-for', `192.0.2.${String(i)}`);
    expect((await handlers.request(attempt)).status).toBe(200);
    time += 1000;
  }
  for (const body of [{ device: 'limited' }, { device: '' }]) {
    const response = await handlers.request(post('requests', body));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('590');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'too many pairing requests' });
  }
  // Polls are guarded by the 256-bit secret, not by the creation limit.
  expect((await poll(handlers, first.poll_secret)).body).toEqual({ status: 'pending' });
  time += 589_600;
  const almostReady = await handlers.request(post('requests', { device: 'limited' }));
  expect(almostReady.status).toBe(429);
  expect(almostReady.headers.get('retry-after')).toBe('1');
  time += 400;
  // Exactly the oldest creation leaves the window; a new creation fills it again.
  expect((await handlers.request(post('requests', { device: 'limited' }))).status).toBe(200);
  expect((await handlers.request(post('requests', { device: 'again' }))).status).toBe(429);
  time += 1000;
  expect((await handlers.request(post('requests', { device: 'again' }))).status).toBe(200);
});

test('concurrent request creations cannot pass the host-wide limit', async () => {
  const handlers = createPairingHandlers({ log: () => undefined, tokens: fixture.tokens });
  const responses = await Promise.all(
    Array.from({ length: 14 }, (_, i) =>
      handlers.request(post('requests', { device: `device-${String(i)}` })),
    ),
  );
  expect(responses.filter((response) => response.status === 200)).toHaveLength(10);
  expect(responses.filter((response) => response.status === 429)).toHaveLength(4);
  expect(await fixture.tokens.listPending()).toHaveLength(10);
  // A new host lifetime resets the in-memory counter.
  const restarted = createPairingHandlers({ log: () => undefined, tokens: fixture.tokens });
  await file(restarted, 'after-restart');
});

test('store faults answer a safe 500, log no detail, and spend no request budget', async () => {
  const lines: string[] = [];
  let broken = true;
  const failing = {
    ...fixture.tokens,
    poll: () => Promise.reject(new Error('driver detail SECRET-POLL')),
    request: (device: string) =>
      broken
        ? Promise.reject(new Error('driver detail SECRET-REQUEST'))
        : fixture.tokens.request(device),
  };
  const handlers = createPairingHandlers({ log: (line) => lines.push(line), tokens: failing });
  for (let i = 0; i < 12; i++) {
    const response = await handlers.request(post('requests', { device: 'faulty' }));
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'the request did not complete' });
  }
  const polled = await handlers.poll(post('poll', { poll_secret: 'secret' }));
  expect(polled.status).toBe(500);
  expect(await polled.json()).toEqual({ error: 'the request did not complete' });
  expect(lines).toHaveLength(13);
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    ...Array.from({ length: 12 }, () => ({
      event: 'pairing_request_fault',
      time: expect.any(String),
    })),
    { event: 'pairing_poll_fault', time: expect.any(String) },
  ]);
  expect(lines.join('\n')).not.toContain('SECRET');
  broken = false;
  await file(handlers, 'recovered');
});
