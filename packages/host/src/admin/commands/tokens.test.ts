import { afterEach, beforeEach, expect, test } from 'bun:test';

import { pairTestDevice } from '@mimir/core/testing';

import { adminFixture } from '../testing';
import type { AdminFixture } from '../testing';

let fixture: AdminFixture;
beforeEach(async () => {
  fixture = await adminFixture();
});
afterEach(async () => fixture.close());

/** The terminal cell a line's `text` starts at: wide characters before it take two. */
function cellOf(line: string, text: string | RegExp): number {
  return Bun.stringWidth(line.slice(0, line.search(text)));
}

test('tokens lists active tokens by device, with user, last use, and pairing date', async () => {
  const token = await pairTestDevice(fixture.host.tokens, 'laptop');
  await fixture.host.tokens.verify(token);
  await pairTestDevice(fixture.host.tokens, 'desktop');
  await pairTestDevice(fixture.host.tokens, 'phone');
  await fixture.host.tokens.revoke('phone');

  const terminal = await fixture.run(['tokens'], { tty: true });
  expect(terminal.exitCode).toBe(0);
  const lines = terminal.stdout.trimEnd().split('\n');
  expect(lines[0]).toMatch(/^DEVICE\s+USER\s+LAST USED\s+PAIRED$/);
  expect(lines).toHaveLength(3);
  expect(lines).toContainEqual(
    expect.stringMatching(/^laptop\s+owner\s+<1m ago\s+\d{4}-\d\d-\d\d$/),
  );
  expect(lines).toContainEqual(
    expect.stringMatching(/^desktop\s+owner\s+never\s+\d{4}-\d\d-\d\d$/),
  );

  const piped = await fixture.run(['tokens']);
  expect(JSON.parse(piped.stdout)).toContainEqual({
    created_at: expect.any(String),
    device: 'laptop',
    id: expect.any(String),
    last_used_at: expect.any(String),
    revoked_at: null,
    user: 'owner',
  });
  expect(JSON.parse(piped.stdout)).toHaveLength(2);
});

test('tokens --all adds a REVOKED column, dated only for revoked tokens', async () => {
  await pairTestDevice(fixture.host.tokens, 'laptop');
  await pairTestDevice(fixture.host.tokens, 'phone');
  await fixture.host.tokens.revoke('phone');

  const run = await fixture.run(['tokens', '--all'], { tty: true });
  const lines = run.stdout.trimEnd().split('\n');
  expect(lines[0]).toMatch(/^DEVICE\s+USER\s+LAST USED\s+PAIRED\s+REVOKED$/);
  expect(lines).toContainEqual(expect.stringMatching(/^laptop\s+owner\s+never\s+\d{4}-\d\d-\d\d$/));
  expect(lines).toContainEqual(
    expect.stringMatching(/^phone\s+owner\s+never\s+\d{4}-\d\d-\d\d\s+\d{4}-\d\d-\d\d$/),
  );
});

test('tokens says so when no device is paired', async () => {
  await pairTestDevice(fixture.host.tokens, 'laptop');
  await fixture.host.tokens.revoke('laptop');

  expect((await fixture.run(['tokens'], { tty: true })).stdout).toBe('No paired devices\n');
});

test('tokens aligns wide-character device names by terminal cell', async () => {
  await pairTestDevice(fixture.host.tokens, '研究室のマシン');
  await pairTestDevice(fixture.host.tokens, 'laptop');

  const lines = (await fixture.run(['tokens'], { tty: true })).stdout.trimEnd().split('\n');
  const rows = lines.slice(1);
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((line) => cellOf(line, 'owner'))).size).toBe(1);
  expect(new Set(rows.map((line) => cellOf(line, /\d{4}-/))).size).toBe(1);
});

test('tokens on a terminal too narrow for its columns prints one block per token', async () => {
  await pairTestDevice(fixture.host.tokens, 'laptop');

  const run = await fixture.run(['tokens'], { columns: 20, tty: true });
  expect(run.stdout).toMatch(/^DEVICE\s+laptop$/m);
  expect(run.stdout).toMatch(/^USER\s+owner$/m);
  expect(run.stdout).toMatch(/^LAST USED\s+never$/m);
});
