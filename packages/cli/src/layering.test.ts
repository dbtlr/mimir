import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The layering rule (ADR 0037): only `src/app.ts` imports `@mimir/core`, so a
 * command reaches work state through the Engine alone. Each case lints a probe
 * module written beside the commands, through the repository's own lint config.
 */
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const probe = fileURLToPath(
  new URL(`commands/layering-probe-${String(process.pid)}.ts`, import.meta.url),
);

afterEach(() => {
  rmSync(probe, { force: true });
});

function lint(path: string): { status: number | null; output: string } {
  const run = spawnSync('bun', ['x', 'vp', 'lint', path], { cwd: repository, encoding: 'utf8' });
  return { output: `${run.stdout}${run.stderr}`, status: run.status };
}

test('a command module that imports @mimir/core is refused', () => {
  writeFileSync(probe, "import { LocalEngine } from '@mimir/core';\n\nexport { LocalEngine };\n");
  const run = lint(probe);
  expect(run.status).not.toBe(0);
  expect(run.output).toContain('only packages/cli/src/app.ts imports @mimir/core');
});

test('a command module that imports the old binary is refused', () => {
  writeFileSync(probe, "export { runCli } from '@mimir/bin/src/cli';\n");
  const run = lint(probe);
  expect(run.status).not.toBe(0);
  expect(run.output).toContain('@mimir/cli may not import @mimir/bin');
});

test('the composition root imports core, and a command the contract, cleanly', () => {
  writeFileSync(probe, "export { MimirError } from '@mimir/contract';\n");
  expect(lint(probe).status).toBe(0);
  expect(lint(fileURLToPath(new URL('app.ts', import.meta.url))).status).toBe(0);
});
