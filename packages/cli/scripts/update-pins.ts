/**
 * Re-record parity pins. Runs the given test files (every parity test when none
 * are named) with `MIMIR_UPDATE_PINS=1` and `MIMIR_PINS_STAGE` set to a
 * directory made for this run alone, where recording writes each file's pins
 * under the encoded path of the file it will replace. Only if the whole run
 * exited 0, every test and every cleanup hook, are those recordings moved onto
 * the pin files. The directory is always removed, so a failed run writes
 * nothing and leaves nothing a later run could promote. Usage:
 *
 *   bun packages/cli/scripts/update-pins.ts [test files...]
 */
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('../src', import.meta.url));
const SCRATCH = fileURLToPath(new URL('../../../.scratch', import.meta.url));

/** The test files to run: those named, else every parity test and the MCP parity test. */
function targets(named: readonly string[]): string[] {
  if (named.length > 0) {
    return named.map((file) => (file.startsWith('/') ? file : join(process.cwd(), file)));
  }
  const commands = join(SOURCE, 'commands');
  return [
    ...readdirSync(commands)
      .filter((name) => name.endsWith('.parity.test.ts'))
      .map((name) => join(commands, name)),
    join(SOURCE, 'mcp-parity.test.ts'),
  ];
}

const files = targets(process.argv.slice(2));
mkdirSync(SCRATCH, { recursive: true });
const stage = mkdtempSync(join(SCRATCH, 'pins-stage-'));
try {
  const run = Bun.spawnSync(['bun', 'test', ...files], {
    env: { ...process.env, MIMIR_PINS_STAGE: stage, MIMIR_UPDATE_PINS: '1' },
    stderr: 'inherit',
    stdout: 'inherit',
  });
  if (run.exitCode === 0) {
    const recorded = readdirSync(stage);
    for (const name of recorded) {
      const target = decodeURIComponent(name);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(join(stage, name), target);
    }
    console.log(`pins updated: ${String(recorded.length)} file(s)`);
  } else {
    console.error('pins not updated: the run did not pass, so nothing was written');
    process.exitCode = run.exitCode || 1;
  }
} finally {
  rmSync(stage, { force: true, recursive: true });
}
