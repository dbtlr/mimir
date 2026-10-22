import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const main = fileURLToPath(new URL('main.ts', import.meta.url));

async function sandbox(...args: string[]): Promise<{ exit: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, main, ...args], {
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { exit, stderr };
}

test('destroy of an unknown sandbox is a one-line refusal, not a defect', async () => {
  const id = randomUUID();
  const { exit, stderr } = await sandbox('destroy', id);
  expect(exit).toBe(1);
  expect(stderr.trim().split('\n')).toHaveLength(1);
  expect(stderr).toContain(`Sandbox ${id} does not exist`);
  expect(stderr).not.toContain('UNHANDLED EXCEPTION');
});

test('a malformed option value is a usage failure', async () => {
  const { exit, stderr } = await sandbox('skill-eval', '--repeat', '0');
  expect(exit).toBe(2);
  expect(stderr).toContain('--repeat must be a positive integer');
  expect(stderr).not.toContain('UNHANDLED EXCEPTION');
});
