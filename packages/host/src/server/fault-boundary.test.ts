import { expect, test } from 'bun:test';

import { MimirError } from '@mimir/contract';
import { z } from 'zod';

import { HostFaultError } from '../api/errors';
import { refusalOf } from './fault-boundary';

/*
 * The server-function fault boundary (MMR-537): an Engine refusal reaches the
 * console as itself, and any other fault reaches it as the house-voice refusal
 * while its cause is logged on the host, once.
 */

function boundary(error: unknown) {
  const lines: string[] = [];
  return { lines, refusal: refusalOf(error, 'tree', (line) => lines.push(line)) };
}

test('an Engine refusal passes through unlogged', () => {
  const refusal = new MimirError('not_found', 'NOPE does not exist');
  const { lines, refusal: out } = boundary(refusal);
  expect(out).toBe(refusal);
  expect(lines).toEqual([]);
});

test('an internal fault becomes the house refusal, its cause logged once', () => {
  const parsed = z.object({ createdAt: z.iso.datetime() }).safeParse({ createdAt: 'garbage' });
  const { lines, refusal } = boundary(parsed.error);
  expect(refusal).toBeInstanceOf(HostFaultError);
  expect(refusal.message).toBe('the request did not complete');
  expect((refusal as HostFaultError).hint).toBe("run 'mimir doctor'");
  expect(refusal.message).not.toContain('createdAt');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith('✗ host: request did not complete — ');
  const diagnostic = JSON.parse(lines[0]?.split(' — ')[1] ?? '{}') as Record<string, string>;
  expect(diagnostic.serverFn).toBe('tree');
  expect(diagnostic.message).toContain('createdAt');
});
