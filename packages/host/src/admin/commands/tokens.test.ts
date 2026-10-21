import { afterEach, beforeEach, expect, test } from 'bun:test';

import { pairTestDevice } from '@mimir/core/testing';

import { adminFixture } from '../testing';
import type { AdminFixture } from '../testing';

let fixture: AdminFixture;
beforeEach(async () => {
  fixture = await adminFixture();
});
afterEach(async () => fixture.close());

test('tokens lists active tokens with user, device, created, last used, and revoked', async () => {
  const token = await pairTestDevice(fixture.host.tokens, 'laptop');
  await fixture.host.tokens.verify(token);
  await pairTestDevice(fixture.host.tokens, 'desktop');
  await fixture.host.tokens.revoke('desktop');

  const terminal = await fixture.run(['tokens'], { tty: true });
  expect(terminal.exitCode).toBe(0);
  const lines = terminal.stdout.trimEnd().split('\n');
  expect(lines[0]).toMatch(/^USER\s+DEVICE\s+CREATED\s+LAST USED\s+REVOKED$/);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toMatch(
    /^owner\s+laptop\s+\d{4}-\d\d-\d\d \d\d:\d\d\s+\d{4}-\d\d-\d\d \d\d:\d\d\s+-$/,
  );

  const piped = await fixture.run(['tokens']);
  expect(JSON.parse(piped.stdout)).toEqual([
    {
      created_at: expect.any(String),
      device: 'laptop',
      id: expect.any(String),
      last_used_at: expect.any(String),
      revoked_at: null,
      user: 'owner',
    },
  ]);
});

test('tokens --all adds the revoked tokens', async () => {
  await pairTestDevice(fixture.host.tokens, 'laptop');
  await fixture.host.tokens.revoke('laptop');

  const run = await fixture.run(['tokens', '--all'], { tty: true });
  expect(run.stdout).toMatch(/owner\s+laptop\s+\S+ \S+\s+-\s+\d{4}-\d\d-\d\d \d\d:\d\d/);
  expect((await fixture.run(['tokens'], { tty: true })).stdout).toBe('No paired devices\n');
});
