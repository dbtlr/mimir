import { expect, test } from 'bun:test';

import { TIMED_OUT, bunExec } from './exec';

test('bunExec captures exit code and output', async () => {
  const r = await bunExec(['sh', '-c', 'printf out; printf err 1>&2; exit 3']);
  expect(r).toEqual({ code: 3, stderr: 'err', stdout: 'out' });
});

test('bunExec kills a hung process and reports code 124', async () => {
  const r = await bunExec(['sleep', '10'], { timeoutMs: 100 });
  expect(r.code).toBe(TIMED_OUT);
  expect(r.stderr).toContain('timed out');
});

test('bunExec within the timeout returns the real result', async () => {
  const r = await bunExec(['sh', '-c', 'printf hi'], { timeoutMs: 5000 });
  expect(r).toEqual({ code: 0, stderr: '', stdout: 'hi' });
});
