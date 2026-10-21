import { afterEach, beforeEach, expect, test } from 'bun:test';

import { MimirError } from '@mimir/contract';
import { healthOf } from '@mimir/core';
import { createTestStore, pairingHost } from '@mimir/core/testing';
import type { TestStore } from '@mimir/core/testing';

import { HostClient, HostRequestError } from './host-client';

let fixture: TestStore;
beforeEach(async () => {
  fixture = await createTestStore();
});
afterEach(async () => fixture.close());

const ORIGIN = 'http://host.test';
const noStore = { 'cache-control': 'no-store' };

const fetchFrom =
  (handler: (request: Request) => Promise<Response>) => (input: string, init: RequestInit) =>
    handler(new Request(input, init));

const clientFor = (handler: (request: Request) => Promise<Response>) =>
  new HostClient({ fetch: fetchFrom(handler), origin: ORIGIN });

const live = () => clientFor(pairingHost(fixture.tokens, '0.26.0'));

async function refusal(promise: Promise<unknown>): Promise<HostRequestError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(HostRequestError);
  expect(error).toBeInstanceOf(MimirError);
  if (!(error instanceof HostRequestError)) {
    throw new Error('expected HostRequestError');
  }
  expect(error.hint).toBeTruthy();
  return error;
}

test('health reads the host build, minimum client, schema, and status', async () => {
  expect(await live().health()).toEqual(healthOf('0.26.0'));
});

test('health refuses an answer that is not a mimir host, as a definite failure', async () => {
  const error = await refusal(clientFor(async () => Response.json({ hello: 'world' })).health());
  expect(error).toMatchObject({ code: 'invariant', transient: false });
});

test('a pairing request returns the code, secret, expiry, and interval', async () => {
  const filed = await live().requestPairing('  laptop  ');
  expect(filed.userCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  expect(filed.pollSecret.length).toBeGreaterThan(20);
  expect(Date.parse(filed.expiresAt)).toBeGreaterThan(Date.now());
  expect(filed.interval).toBe(2);
});

test('the request body carries only the device name, as JSON', async () => {
  let seen: { body: unknown; method: string; path: string } | undefined;
  await clientFor(async (request) => {
    seen = {
      body: await request.json(),
      method: request.method,
      path: new URL(request.url).pathname,
    };
    return pairingHost(
      fixture.tokens,
      '0.26.0',
    )(new Request(request.url, { body: JSON.stringify(seen.body), method: 'POST' }));
  }).requestPairing('laptop');
  expect(seen).toEqual({
    body: { device: 'laptop' },
    method: 'POST',
    path: '/auth/pairing/requests',
  });
});

test.each(['', '   ', 'x'.repeat(129), 'bad\nname'])(
  'a rejected device name %j is a definite validation refusal',
  async (device) => {
    const error = await refusal(live().requestPairing(device));
    expect(error).toMatchObject({ code: 'validation', status: 400, transient: false });
  },
);

test('a poll walks pending, then approved with the device and token', async () => {
  const client = live();
  const filed = await client.requestPairing('laptop');
  expect(await client.pollPairing(filed.pollSecret)).toEqual({ status: 'pending' });
  await fixture.tokens.approve(filed.userCode);
  const approved = await client.pollPairing(filed.pollSecret);
  expect(approved).toMatchObject({ device: 'laptop', status: 'approved' });
  if (approved.status !== 'approved') {
    throw new Error('expected approval');
  }
  expect(await fixture.tokens.verify(approved.token)).toBeTruthy();
  // The approval is single-use: the request is consumed.
  expect(await client.pollPairing(filed.pollSecret)).toEqual({ status: 'expired' });
});

test('a denied request polls as denied', async () => {
  const client = live();
  const filed = await client.requestPairing('laptop');
  await fixture.tokens.deny(filed.userCode);
  expect(await client.pollPairing(filed.pollSecret)).toEqual({ status: 'denied' });
});

test('an unknown poll secret polls as expired', async () => {
  expect(await live().pollPairing('never-issued')).toEqual({ status: 'expired' });
});

test('an approved request awaiting collection refuses a new one with the host hint', async () => {
  const client = live();
  const filed = await client.requestPairing('laptop');
  await fixture.tokens.approve(filed.userCode);
  const error = await refusal(client.requestPairing('laptop'));
  expect(error).toMatchObject({ code: 'conflict', status: 409, transient: false });
  expect(error.message).toContain('approved pairing request awaiting collection');
  expect(error.hint).toBe(
    'deny or unpair the device on the host, or wait for the approval to expire',
  );
});

test('a rate-limited request carries Retry-After as a definite refusal', async () => {
  const error = await refusal(
    clientFor(async () =>
      Response.json(
        { error: 'too many pairing requests' },
        { headers: { ...noStore, 'retry-after': '312' }, status: 429 },
      ),
    ).requestPairing('laptop'),
  );
  expect(error).toMatchObject({ code: 'conflict', retryAfter: 312, status: 429, transient: false });
  expect(error.hint).toContain('312');
});

test('a 429 without a usable Retry-After still refuses, with no retryAfter', async () => {
  const error = await refusal(
    clientFor(async () =>
      Response.json({ error: 'too many' }, { headers: { 'retry-after': 'soon' }, status: 429 }),
    ).requestPairing('laptop'),
  );
  expect(error.retryAfter).toBeUndefined();
});

test('a poll that is rate limited by a proxy is transient and carries Retry-After', async () => {
  const error = await refusal(
    clientFor(async () =>
      Response.json({}, { headers: { 'retry-after': '5' }, status: 429 }),
    ).pollPairing('secret'),
  );
  expect(error).toMatchObject({ retryAfter: 5, transient: true });
});

const transientFailures: [string, () => Promise<Response>][] = [
  ['a network error', () => Promise.reject(new TypeError('connection refused'))],
  ['a 500', async () => Response.json({ error: 'the request did not complete' }, { status: 500 })],
  ['a 502 proxy page', async () => new Response('<html>Bad Gateway</html>', { status: 502 })],
  ['a non-JSON 200', async () => new Response('<html>captive portal</html>', { status: 200 })],
  ['a non-JSON 408', async () => new Response('timeout', { status: 408 })],
  ['a JSON 408', async () => Response.json({ error: 'timeout' }, { status: 408 })],
];

// Only the network, a timeout, a 5xx, 408, and 429 are worth retrying; any other 4xx is the host's answer.
const definiteFailures: [string, () => Promise<Response>][] = [
  ['a proxy HTML 401', async () => new Response('<html>log in</html>', { status: 401 })],
  ['a proxy HTML 403', async () => new Response('<html>forbidden</html>', { status: 403 })],
  ['a non-JSON 404', async () => new Response('404 page not found', { status: 404 })],
  ['a JSON 404', async () => Response.json({ error: 'nope' }, { status: 404 })],
];

test.each(definiteFailures)('%s is definite on a poll', async (_name, answer) => {
  expect((await refusal(clientFor(answer).pollPairing('secret'))).transient).toBe(false);
});

test.each(definiteFailures)('%s is definite on a pairing request', async (_name, answer) => {
  expect((await refusal(clientFor(answer).requestPairing('laptop'))).transient).toBe(false);
});

test.each(definiteFailures)('%s is definite on health', async (_name, answer) => {
  expect((await refusal(clientFor(answer).health())).transient).toBe(false);
});

// A redirect would carry the device name or poll secret to wherever it points, so none is followed.
const redirect = (status: number, location: string) => async () =>
  new Response(null, { headers: { location }, status });

test('the client asks fetch not to follow redirects', async () => {
  const seen: RequestInit[] = [];
  const client = new HostClient({
    fetch: async (_input, init) => {
      seen.push(init);
      return Response.json(healthOf('0.26.0'));
    },
    origin: ORIGIN,
  });
  await client.health();
  await client.requestPairing('laptop').catch(() => undefined);
  await client.pollPairing('secret').catch(() => undefined);
  expect(seen.map((init) => init.redirect)).toEqual(['manual', 'manual', 'manual']);
});

test.each([301, 302, 307, 308])(
  'a %i is a definite refusal naming the target origin',
  async (status) => {
    const answer = redirect(status, 'https://elsewhere.test/auth/pairing/poll?x=1');
    for (const call of [
      (client: HostClient) => client.health(),
      (client: HostClient) => client.requestPairing('laptop'),
      (client: HostClient) => client.pollPairing('secret'),
    ]) {
      const error = await refusal(call(clientFor(answer)));
      expect(error).toMatchObject({ code: 'invariant', status, transient: false });
      expect(error.message).toBe(`the host at ${ORIGIN} redirected to https://elsewhere.test`);
      expect(error.hint).toContain('mimir pair https://elsewhere.test');
    }
  },
);

test('a redirect whose target is not an http origin names no target', async () => {
  const error = await refusal(clientFor(redirect(307, 'data:text/plain,\u001B[2Jx')).health());
  expect(error.message).toBe(`the host at ${ORIGIN} redirected`);
  expect(`${error.message} ${String(error.hint)}`).not.toContain('\u001B');
});

test.each(transientFailures)('%s is transient on a poll', async (_name, answer) => {
  const error = await refusal(clientFor(answer).pollPairing('secret'));
  expect(error).toMatchObject({ code: 'invariant', transient: true });
});

test.each(transientFailures)(
  '%s is flagged transient on a pairing request',
  async (_name, answer) => {
    const error = await refusal(clientFor(answer).requestPairing('laptop'));
    expect(error.transient).toBe(true);
  },
);

test.each(transientFailures)('%s is flagged transient on health', async (_name, answer) => {
  const error = await refusal(clientFor(answer).health());
  expect(error.transient).toBe(true);
});

test('a request that exceeds its timeout is a transient failure', async () => {
  const client = new HostClient({
    fetch: async (_input, init) => {
      await Bun.sleep(200);
      init.signal?.throwIfAborted();
      return Response.json({});
    },
    origin: ORIGIN,
    timeoutMs: 20,
  });
  expect(await refusal(client.pollPairing('secret'))).toMatchObject({ transient: true });
});

test.each([400, 403, 404, 405])('a %i poll answer is definite', async (status) => {
  const error = await refusal(
    clientFor(async () => Response.json({ error: 'nope' }, { status })).pollPairing('secret'),
  );
  expect(error).toMatchObject({ status, transient: false });
});

test('a poll answer with an unknown status is definite', async () => {
  const error = await refusal(
    clientFor(async () => Response.json({ status: 'maybe' })).pollPairing('secret'),
  );
  expect(error).toMatchObject({ code: 'invariant', transient: false });
});

test('an approved poll answer without a token is definite', async () => {
  const error = await refusal(
    clientFor(async () => Response.json({ device: 'laptop', status: 'approved' })).pollPairing(
      'secret',
    ),
  );
  expect(error.transient).toBe(false);
});

test('a filed-request answer missing a field is definite', async () => {
  const error = await refusal(
    clientFor(async () => Response.json({ user_code: 'ABCD-EFGH' })).requestPairing('laptop'),
  );
  expect(error.transient).toBe(false);
});

test('a missing pairing route says the host may be too old', async () => {
  const error = await refusal(
    clientFor(async () =>
      Response.json({ error: { code: 'not_found' } }, { status: 404 }),
    ).requestPairing('laptop'),
  );
  expect(error.hint).toContain('update the host');
});

test('no refusal echoes the poll secret, the token, or the response body', async () => {
  const secret = 'poll-secret-0123456789';
  const token = 'device-token-0123456789';
  const answers = [
    () => Promise.reject(new TypeError(`failed ${secret}`)),
    async () => Response.json({ error: `bad ${secret} ${token}` }, { status: 400 }),
    async () => Response.json({ error: `bad ${secret} ${token}` }, { status: 503 }),
    async () => new Response(`${secret} ${token}`, { status: 200 }),
    async () => Response.json({ status: 'approved', token }),
  ];
  for (const answer of answers) {
    const error = await refusal(clientFor(answer).pollPairing(secret));
    expect(`${error.message} ${error.hint ?? ''}`).not.toContain(secret);
    expect(`${error.message} ${error.hint ?? ''}`).not.toContain(token);
  }
});

test('the origin is reduced to scheme and authority when building URLs', async () => {
  const seen: string[] = [];
  const client = new HostClient({
    fetch: (input) => {
      seen.push(input);
      return Promise.resolve(Response.json(healthOf('0.26.0')));
    },
    origin: 'https://mimir.example.ts.net:8443/ignored/path',
  });
  await client.health();
  expect(seen).toEqual(['https://mimir.example.ts.net:8443/health']);
});

const filedBody = (interval: number) => ({
  expires_at: '2026-10-21T12:10:00.000Z',
  interval,
  poll_secret: 'poll-secret-0123456789',
  user_code: 'ABCD-EFGH',
});

test.each([
  [0.01, 1],
  [0.5, 1],
  [2, 2],
  [60, 60],
  [61, 60],
  [1e12, 60],
])('a host interval of %p seconds is used as %p', async (stated, used) => {
  const filed = await clientFor(async () => Response.json(filedBody(stated))).requestPairing(
    'laptop',
  );
  expect(filed.interval).toBe(used);
});

test("the host's Date header is the host's clock at filing; absent or junk reads as absent", async () => {
  const at = new Date('2026-10-21T12:00:00.000Z');
  const dated = await clientFor(async () =>
    Response.json(filedBody(2), { headers: { date: at.toUTCString() } }),
  ).requestPairing('laptop');
  expect(dated.hostNow).toBe(at.getTime());
  for (const headers of [{}, { date: 'yesterday-ish' }]) {
    const filed = await clientFor(async () =>
      Response.json(filedBody(2), { headers }),
    ).requestPairing('laptop');
    expect(filed.hostNow).toBeUndefined();
  }
});

test('an abort stops a poll in flight at once, as a transient failure', async () => {
  const controller = new AbortController();
  const client = new HostClient({
    fetch: async (_input, init) => {
      // Hangs until the request's signal aborts, as a stalled connection would.
      for (let waited = 0; waited < 5000; waited += 5) {
        init.signal?.throwIfAborted();
        await Bun.sleep(5);
      }
      return Response.json({});
    },
    origin: ORIGIN,
  });
  const polling = refusal(client.pollPairing('secret', controller.signal));
  controller.abort();
  expect((await polling).transient).toBe(true);
});
