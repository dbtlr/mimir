import { expect, test } from 'bun:test';

import { parseHealth, probeHealth } from './health';

test('parseHealth accepts the owned health response', () => {
  expect(parseHealth({ schema: 8, status: 'ok', version: '0.18.0-next.1' })).toEqual({
    schema: 8,
    status: 'ok',
    version: '0.18.0-next.1',
  });
});

test('parseHealth fails soft when an owned field is missing', () => {
  expect(parseHealth({ schema: 8, status: 'ok' })).toBeUndefined();
});

test('parseHealth fails soft when an owned field has the wrong type', () => {
  expect(parseHealth({ schema: '8', status: 'ok', version: '0.18.0' })).toBeUndefined();
  expect(parseHealth({ schema: 8, status: true, version: '0.18.0' })).toBeUndefined();
  expect(parseHealth({ schema: 8, status: 'ok', version: 18 })).toBeUndefined();
});

test('probeHealth presents a loopback Host, so a [serve] hosts allowlist never refuses it', async () => {
  const seenHosts: (string | null)[] = [];
  const fake = Bun.serve({
    fetch(req) {
      seenHosts.push(req.headers.get('host'));
      return Response.json({ schema: 8, status: 'ok', version: '0.18.0' });
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  try {
    expect(await probeHealth('127.0.0.1', fake.port ?? 0)).toEqual({
      schema: 8,
      status: 'ok',
      version: '0.18.0',
    });
    expect(seenHosts).toEqual(['localhost']);
  } finally {
    await fake.stop(true);
  }
});

test('probeHealth is undefined when nothing answers', async () => {
  const fake = Bun.serve({ fetch: () => new Response('x'), hostname: '127.0.0.1', port: 0 });
  const port = fake.port ?? 0;
  await fake.stop(true);
  expect(await probeHealth('127.0.0.1', port)).toBeUndefined();
});
