import { afterEach, beforeEach, expect, test } from 'bun:test';

import { adminFixture } from '../testing';
import type { AdminFixture } from '../testing';

let fixture: AdminFixture;
beforeEach(async () => {
  fixture = await adminFixture();
});
afterEach(async () => fixture.close());

test('pending lists live requests by device with their age and expiry', async () => {
  await fixture.host.tokens.request('laptop');
  const filed = Date.now();

  const terminal = await fixture.run(['pending'], { now: new Date(filed + 3 * 60_000), tty: true });
  expect(terminal.exitCode).toBe(0);
  expect(terminal.stdout).toMatch(/DEVICE\s+REQUESTED\s+EXPIRES/);
  expect(terminal.stdout).toMatch(/laptop\s+3m ago\s+in 7m/);
  expect(terminal.stdout).toContain('mimir-host approve <code>');

  const piped = await fixture.run(['pending']);
  expect(JSON.parse(piped.stdout)).toEqual([
    { created_at: expect.any(String), device: 'laptop', expires_at: expect.any(String) },
  ]);
});

test('pending aligns wide-character device names by terminal cell', async () => {
  await fixture.host.tokens.request('研究室のマシン');
  await fixture.host.tokens.request('laptop');

  const lines = (await fixture.run(['pending'], { tty: true })).stdout.split('\n').slice(0, 3);
  const cells = lines.map((line) =>
    Bun.stringWidth(line.slice(0, line.search(/REQUESTED|<1m ago/))),
  );
  expect(new Set(cells).size).toBe(1);
});

test('pending on a terminal too narrow for its columns prints one block per request', async () => {
  await fixture.host.tokens.request('valhalla-build-runner-02');

  const run = await fixture.run(['pending'], { columns: 24, tty: true });
  expect(run.stdout).toMatch(/^DEVICE\s+valhalla-build-runner-02$/m);
  expect(run.stdout).toMatch(/^EXPIRES\s+in \d+m$/m);
  expect(run.stdout).toContain('mimir-host approve <code>');
});

test('pending says so when no request waits', async () => {
  const run = await fixture.run(['pending'], { tty: true });
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toBe('No pending pairing requests\n');
});

test('approve accepts the code the client shows, and the client collects its token', async () => {
  const request = await fixture.host.tokens.request('laptop');

  const run = await fixture.run(['approve', request.user_code.toLowerCase()], { tty: true });
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toBe('[ok] approved laptop\n');
  const answer = await fixture.host.tokens.poll(request.poll_secret);
  expect(answer).toMatchObject({ device: 'laptop', status: 'approved' });
});

test('approve notes that a device holding a token has it replaced', async () => {
  const first = await fixture.host.tokens.request('laptop');
  await fixture.host.tokens.approve(first.user_code);
  await fixture.host.tokens.poll(first.poll_secret);
  const again = await fixture.host.tokens.request('laptop');

  const terminal = await fixture.run(['approve', again.user_code], { tty: true });
  expect(terminal.stdout).toContain('[ok] approved laptop');
  expect(terminal.stdout).toContain("laptop's current token stops working");

  const other = await fixture.host.tokens.request('desktop');
  const piped = await fixture.run(['approve', other.user_code]);
  expect(JSON.parse(piped.stdout)).toEqual({ device: 'desktop', rotates: false });
});

test('approve refuses a code no live request carries, and a string that is not a code', async () => {
  const missing = await fixture.run(['approve', 'ABCD-EFGH']);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toContain('no live pairing request matches ABCD-EFGH');
  expect(missing.stderr).toContain('mimir-host pending');

  const malformed = await fixture.run(['approve', 'not-a-code']);
  expect(malformed.exitCode).toBe(2);
  expect(malformed.stderr).toContain('not-a-code is not a pairing code');
});

test('deny rejects the request, and the client hears denied', async () => {
  const request = await fixture.host.tokens.request('laptop');

  const run = await fixture.run(['deny', request.user_code], { tty: true });
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toBe('[ok] denied laptop\n');
  expect(await fixture.host.tokens.poll(request.poll_secret)).toEqual({ status: 'denied' });

  const again = await fixture.run(['deny', request.user_code]);
  expect(again.exitCode).toBe(1);
  expect(again.stderr).toContain(`no live pairing request matches ${request.user_code}`);
});

test('unpair revokes the token, keeps its row, and discards the device requests', async () => {
  const first = await fixture.host.tokens.request('laptop');
  await fixture.host.tokens.approve(first.user_code);
  const answer = await fixture.host.tokens.poll(first.poll_secret);
  if (answer.status !== 'approved') {
    throw new Error('fixture pairing did not approve');
  }
  await fixture.host.tokens.request('laptop');

  const run = await fixture.run(['unpair', 'laptop'], { tty: true });
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toBe('[ok] unpaired laptop (1 token revoked, 1 request discarded)\n');
  expect(await fixture.host.tokens.verify(answer.token)).toBeNull();
  expect(await fixture.host.tokens.list({ all: true })).toEqual([
    expect.objectContaining({ device: 'laptop', revoked_at: expect.any(String) }),
  ]);
  expect(await fixture.host.tokens.listPending()).toEqual([]);
});

test('unpair refuses a device with nothing to revoke', async () => {
  const run = await fixture.run(['unpair', 'laptop']);
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain('no active token or pairing request for laptop');
  expect(run.stderr).toContain('mimir-host tokens');
});
